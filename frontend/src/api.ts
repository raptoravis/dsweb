export interface User {
  id: string;
  email: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface TraceStep {
  id: string;
  kind: "tool" | "step";
  title: string;
  status: "running" | "completed" | "error";
  detail?: unknown;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace: TraceStep[];
  createdAt: number;
}

export type DshEvent =
  | { type: "status"; status: "running" | "idle" }
  | { type: "assistant"; delta: string }
  | { type: "trace"; step: TraceStep }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      res.status,
    );
  }
  return json as T;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/register", { email, password }),
  login: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/login", { email, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<{ user: User }>("GET", "/api/auth/me"),

  listConversations: () =>
    request<{ conversations: Conversation[] }>("GET", "/api/conversations"),
  createConversation: (title?: string) =>
    request<{ conversation: Conversation }>("POST", "/api/conversations", title ? { title } : {}),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: Conversation }>("PATCH", `/api/conversations/${id}`, { title }),
  deleteConversation: (id: string) =>
    request<void>("DELETE", `/api/conversations/${id}`),
  getConversation: (id: string) =>
    request<{ conversation: Conversation; messages: Message[] }>(
      "GET",
      `/api/conversations/${id}`,
    ),
};

/**
 * POST a message and stream the SSE reply, invoking `onEvent` per frame.
 * Resolves once the stream ends (done/error/socket close).
 */
export async function sendMessage(
  id: string,
  content: string,
  onEvent: (event: DshEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/conversations/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    credentials: "same-origin",
  });
  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) onEvent(event);
    }
  }
}

function parseSseBlock(block: string): DshEvent | null {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as DshEvent;
  } catch {
    return null;
  }
}
