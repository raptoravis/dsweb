import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { FakeAdapterFactory, FakeDshStore } from "../src/dsh/fake.js";
import { ProcessManager } from "../src/dsh/process-manager.js";
import type { DshEvent } from "../src/dsh/types.js";

export interface TestServer {
  db: Db;
  store: FakeDshStore;
  dsh: ProcessManager;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boot a backend wired to the fake dsh adapter for integration tests. */
export async function startTestServer(options?: {
  idleTimeoutMs?: number;
  maxConcurrent?: number;
}): Promise<TestServer> {
  const db = new Db(":memory:");
  const store = new FakeDshStore();
  const dsh = new ProcessManager(
    new FakeAdapterFactory(store),
    {
      idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
      maxConcurrent: options?.maxConcurrent ?? 64,
      homeBase: "/tmp/dsweb-test-homes",
    },
  );
  const app = createApp(db, dsh);
  const server = app.listen(0);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    store,
    dsh,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
      await dsh.closeAll();
      db.close();
    },
  };
}

/** Minimal cookie-jar fetch client against the Seam 1 HTTP API. */
export class TestClient {
  private cookie = "";

  constructor(private readonly baseUrl: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      this.cookie = pair ? pair.trim() : this.cookie;
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  register(email: string, password: string) {
    return this.request("POST", "/api/auth/register", { email, password });
  }
  login(email: string, password: string) {
    return this.request("POST", "/api/auth/login", { email, password });
  }
  logout() {
    return this.request("POST", "/api/auth/logout");
  }
  me() {
    return this.request("GET", "/api/auth/me");
  }
  listConversations() {
    return this.request("GET", "/api/conversations");
  }
  createConversation(title?: string) {
    return this.request("POST", "/api/conversations", title ? { title } : {});
  }
  getConversation(id: string) {
    return this.request("GET", `/api/conversations/${id}`);
  }
  rename(id: string, title: string) {
    return this.request("PATCH", `/api/conversations/${id}`, { title });
  }
  delete(id: string) {
    return this.request("DELETE", `/api/conversations/${id}`);
  }
  async sendMessage(id: string, content: string): Promise<DshEvent[]> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: JSON.stringify({ content }),
    });
    const text = await res.text();
    return parseSse(text);
  }
}

/** Parse a full SSE body into its events, preserving order. */
export function parseSse(text: string): DshEvent[] {
  const events: DshEvent[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as DshEvent);
    } catch {
      // ignore malformed
    }
  }
  return events;
}

export function collectText(events: DshEvent[]): string {
  return events
    .filter((e): e is Extract<DshEvent, { type: "assistant" }> => e.type === "assistant")
    .map((e) => e.delta)
    .join("");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
