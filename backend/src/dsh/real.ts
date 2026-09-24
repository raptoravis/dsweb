import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { AsyncQueue } from "./async-queue.js";
import { JsonRpcClient } from "./stdio-rpc.js";
import type { DshAdapter, DshAdapterFactory, DshEvent, TraceStep } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RealDshOptions {
  /** Full spawn argv, e.g. `["dsh", "--profile", "sdk"]`. */
  command: string[];
  provider: string;
  model: string;
  /** Admin DeepSeek key, injected into the child env only (never logged). */
  apiKey?: string;
  /** Absolute harness home for this user. */
  userHome: string;
}

interface SessionQueue {
  queue: AsyncQueue<DshEvent>;
}

/**
 * Drives a real `dsh --profile sdk` subprocess over stdio JSON-RPC. Each
 * instance owns one process bound to one user's harness home; the process
 * manager owns spawn/recycle/relaunch.
 */
export class RealDshAdapter implements DshAdapter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: JsonRpcClient;
  private readonly sessions = new Map<string, SessionQueue>();
  private readonly ready: Promise<void>;
  private closed = false;
  /** Raw `initialize` result, exposed for the thin adapter test. */
  initializeResult: unknown;

  constructor(private readonly options: RealDshOptions) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: options.userHome,
    };
    if (options.apiKey) env.DEEPSEEK_API_KEY = options.apiKey;

    this.child = spawnDsh(options.command, env);

    this.rpc = new JsonRpcClient((line) => {
      if (this.child.stdin.writable) this.child.stdin.write(line);
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.rpc.feed(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Diagnostics only; stdout is reserved for protocol frames.
      process.stderr.write(`[dsh:${options.userHome}] ${chunk.toString("utf8")}`);
    });
    this.rpc.onNotification((method, params) => this.onNotification(method, params));

    // `ready` settles on the handshake. A spawn error or pre-handshake exit
    // rejects it so `turn()` fails fast instead of hanging forever.
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once("error", (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      this.child.once("exit", (code) => {
        reject(new Error(`dsh exited before initialization (code ${code ?? "?"})`));
      });
      this.initialize().then(resolve, reject);
    });

    // After the handshake, a crash must fail any in-flight turn's stream.
    this.child.on("exit", () => this.failQueues("dsh 进程已退出"));
    this.child.on("error", (err) =>
      this.failQueues(err instanceof Error ? err.message : String(err)),
    );
  }

  private async initialize(): Promise<void> {
    this.initializeResult = await withTimeout(
      this.rpc.request("initialize", {
        cwd: this.options.userHome,
        provider: this.options.provider,
        model: this.options.model,
      }),
      30_000,
      "dsh 初始化超时",
    );
  }

  /** Resolves once the handshake has completed (used by the thin test). */
  waitReady(): Promise<void> {
    return this.ready;
  }

  async *turn(sessionId: string, content: string): AsyncIterable<DshEvent> {
    await this.ready;
    if (this.closed) {
      yield { type: "error", message: "dsh 连接已关闭" };
      return;
    }
    await withTimeout(
      this.rpc.request("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text: content }],
      }),
      30_000,
      "dsh 无响应",
    );
    const session = this.ensure(sessionId);
    for await (const event of session.queue) {
      yield event;
      if (event.type === "done" || event.type === "error") return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failQueues("dsh 连接已关闭");
    try {
      await Promise.race([
        this.rpc.request("shutdown", undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // fall through to the kill below
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await killChildTree(this.child);
    }
  }

  private ensure(sessionId: string): SessionQueue {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { queue: new AsyncQueue<DshEvent>() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private failQueues(message: string): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.queue.push({ type: "error", message });
      session.queue.close();
    }
    this.sessions.clear();
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    if (method === "session.status") {
      const sessionId = params.sessionId;
      const status = params.status;
      if (typeof sessionId === "string" && (status === "idle" || status === "running")) {
        this.ensure(sessionId).queue.push({ type: "status", status });
      }
      return;
    }
    if (method === "session.event") {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string") return;
      const session = this.ensure(sessionId);
      for (const event of mapSessionEvent(params.event as DshSessionEvent | undefined)) {
        session.queue.push(event);
      }
      return;
    }
    // `subagent.started` / `subagent.finished` are not surfaced in v1.
  }
}

/** Factory that spawns a real dsh process per user home. */
export class RealAdapterFactory implements DshAdapterFactory {
  constructor(private readonly options: Omit<RealDshOptions, "userHome">) {}

  async create(userHome: string): Promise<DshAdapter> {
    return new RealDshAdapter({ ...this.options, userHome });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The subset of dsh's `SessionEvent` envelope this adapter reads. */
interface DshSessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

const STDIO: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

function quoteCmdArg(arg: string): string {
  return /[ \t"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Spawn the dsh command cross-platform. On Windows the `dsh` shim is a `.cmd`
 * batch file, which `spawn` cannot exec directly, so it goes through a shell —
 * passing a single quoted command line (rather than an args array) to avoid
 * Node's DEP0190 argument-concatenation warning.
 */
function spawnDsh(
  command: string[],
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    const commandLine = command.map(quoteCmdArg).join(" ");
    return spawn(commandLine, { env, stdio: STDIO, shell: true });
  }
  return spawn(command[0] ?? "", command.slice(1), { env, stdio: STDIO });
}

/**
 * Terminate the child and, on Windows, its whole process tree — `child.kill()`
 * alone only kills the `cmd.exe` shell a `.cmd` shim runs under, leaking dsh.
 */
async function killChildTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    } catch {
      // process already gone — fall through
    }
  }
  child.kill("SIGKILL");
}

function traceStep(
  id: string,
  title: string,
  status: TraceStep["status"],
  detail?: unknown,
): TraceStep {
  return { id, kind: "tool", title, status, detail };
}

function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => b && typeof b === "object" && (b.type === "text" || b.type === "reasoning") && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    return typeof (content as { text: unknown }).text === "string"
      ? (content as { text: string }).text
      : "";
  }
  return "";
}

/** Map one dsh session-log event into zero or more panel events. */
function mapSessionEvent(event: DshSessionEvent | undefined): DshEvent[] {
  if (!event) return [];
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant/message": {
      const message = data.message as { content?: unknown } | undefined;
      const blocks = message?.content;
      if (!Array.isArray(blocks)) return [];
      const events: DshEvent[] = [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; arguments?: string; toolCallId?: string; content?: unknown; isError?: boolean };
        if (b.type === "text" && typeof b.text === "string") {
          events.push({ type: "assistant", delta: b.text });
        } else if (b.type === "reasoning" && typeof b.text === "string") {
          events.push({
            type: "trace",
            step: traceStep(`reasoning-${randomUUID()}`, "推理", "completed", { text: b.text }),
          });
        } else if (b.type === "tool-call") {
          const id = b.id ?? randomUUID();
          events.push({
            type: "trace",
            step: traceStep(id, `调用工具 ${b.name ?? ""}`.trim(), "running", { arguments: b.arguments }),
          });
        } else if (b.type === "tool-result") {
          const id = b.toolCallId ?? randomUUID();
          events.push({
            type: "trace",
            step: traceStep(id, "工具结果", b.isError ? "error" : "completed", {
              content: textOf(b.content),
            }),
          });
        }
      }
      return events;
    }
    case "tool/call": {
      const id = (data.callId as string) ?? randomUUID();
      return [
        {
          type: "trace",
          step: traceStep(id, `调用工具 ${data.name ?? ""}`.trim(), "running", {
            arguments: data.arguments,
          }),
        },
      ];
    }
    case "tool/result": {
      const message = data.message as { toolCallId?: unknown; content?: unknown; isError?: boolean } | undefined;
      const id = (message?.toolCallId as string) ?? randomUUID();
      return [
        {
          type: "trace",
          step: traceStep(id, "工具结果", message?.isError ? "error" : "completed", {
            content: textOf(message?.content),
          }),
        },
      ];
    }
    case "turn/end": {
      return [{ type: "done", messageId: "turn" }];
    }
    default:
      return [];
  }
}
