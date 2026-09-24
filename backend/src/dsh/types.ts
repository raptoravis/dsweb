/**
 * Seam 2 — the deepseek-harness driver surface.
 *
 * The backend treats dsh as an opaque agent runtime behind this interface so
 * business logic never depends on dsh internals. A `DshAdapter` drives one
 * user's runtime; a `DshService` drives the runtime keyed by user id (the
 * process manager is the real implementation, the fake service is the test
 * double).
 *
 * `turn` enqueues a user message and streams the resulting assistant events
 * until `done`/`error`, so enqueue + stream are one atomic operation. The
 * process manager serializes turns per session, which keeps a shared runtime's
 * event queue single-consumer.
 */

/** One step in an assistant turn's execution trace (collapsed by default). */
export interface TraceStep {
  id: string;
  kind: "tool" | "step";
  /** Human-readable summary line, e.g. "调用工具 read_file". */
  title: string;
  status: "running" | "completed" | "error";
  /** Expandable detail (tool input/output, error payload, …). */
  detail?: unknown;
}

/**
 * Live event streamed over SSE while an assistant turn is in flight. The
 * backend persists these into history as it consumes them.
 */
export type DshEvent =
  | { type: "status"; status: "running" | "idle" }
  | { type: "assistant"; delta: string }
  | { type: "trace"; step: TraceStep }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

/** Drives one user's dsh runtime. */
export interface DshAdapter {
  /** Enqueue a user turn and stream its events until done/error. */
  turn(sessionId: string, content: string): AsyncIterable<DshEvent>;
  /** Tear down the underlying process/runtime. */
  close(): Promise<void>;
}

/** Creates a `DshAdapter` for one user's harness home. */
export interface DshAdapterFactory {
  create(userHome: string): Promise<DshAdapter>;
}

/** Drives dsh keyed by user id. */
export interface DshService {
  turn(userId: string, sessionId: string, content: string): AsyncIterable<DshEvent>;
  closeAll(): Promise<void>;
}
