/**
 * Minimal newline-delimited JSON-RPC 2.0 client for the dsh stdio SDK. We
 * hand-roll this rather than depend on `@deepseek-ai/dsh-sdk-protocol` so the
 * adapter stays a thin, self-contained boundary against dsh's breaking
 * changes (developer preview).
 */
export type JsonRpcNotificationHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcClient {
  private buffer = "";
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private notifyHandler: JsonRpcNotificationHandler | undefined;

  constructor(private readonly write: (line: string) => void) {}

  onNotification(handler: JsonRpcNotificationHandler): void {
    this.notifyHandler = handler;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(`${JSON.stringify(frame)}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Feed raw bytes from the child's stdout; may span multiple frames. */
  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // malformed frames are ignored per the wire contract
    }
    if (!message || typeof message !== "object") return;
    const frame = message as Record<string, unknown>;
    const id = frame.id;
    const method = frame.method;

    if (typeof id === "number" && typeof method === "string") {
      // Server→client request — the dsh runtime never sends one; ignore.
      return;
    }
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (frame.error && typeof frame.error === "object") {
        const err = frame.error as { code?: number; message?: string; data?: unknown };
        pending.reject(new Error(err.message ?? "JSON-RPC error"));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (typeof method === "string") {
      const params =
        frame.params && typeof frame.params === "object"
          ? (frame.params as Record<string, unknown>)
          : {};
      this.notifyHandler?.(method, params);
    }
  }
}
