import { randomUUID } from "node:crypto";
import type { DshAdapter, DshAdapterFactory, DshEvent } from "./types.js";

/**
 * A scripted assistant turn: a function that, given the user's message,
 * yields the events the fake runtime should emit (chunks, trace steps, …).
 * It may emit `done`/`error` itself; if it ends without one, the fake runtime
 * synthesizes `done`.
 */
export type Responder = (
  content: string,
) => AsyncIterable<DshEvent> | DshEvent[];

function toAsyncIter(
  events: AsyncIterable<DshEvent> | DshEvent[],
): AsyncIterable<DshEvent> {
  if (Symbol.asyncIterator in events) return events as AsyncIterable<DshEvent>;
  return (async function* () {
    yield* events as DshEvent[];
  })();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * In-memory session state shared by every `FakeDshAdapter` instance, so a
 * session's scripted responder survives adapter recycle — the same way a real
 * harness home outlives its process. Because session ids are globally unique,
 * the flat map is naturally per-user isolated.
 */
export class FakeDshStore {
  private responders = new Map<string, Responder>();

  constructor(private readonly responder: Responder = defaultResponder) {}

  /** Script a specific session's next turns. */
  setResponder(sessionId: string, responder: Responder): void {
    this.responders.set(sessionId, responder);
  }

  responderFor(sessionId: string): Responder {
    return this.responders.get(sessionId) ?? this.responder;
  }
}

/** The fake dsh runtime for one user's harness home. */
export class FakeDshAdapter implements DshAdapter {
  constructor(private readonly store: FakeDshStore) {}

  async *turn(sessionId: string, content: string): AsyncIterable<DshEvent> {
    const responder = this.store.responderFor(sessionId);
    try {
      for await (const event of toAsyncIter(responder(content))) {
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
      yield { type: "done", messageId: randomUUID() };
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
    }
  }

  async close(): Promise<void> {
    // A real adapter terminates its subprocess here; the fake shares its
    // store, so closing one handle must not drop the shared session state.
  }
}

/** Factory for the fake adapter — the test double for the process manager. */
export class FakeAdapterFactory implements DshAdapterFactory {
  constructor(private readonly store: FakeDshStore) {}

  async create(): Promise<DshAdapter> {
    return new FakeDshAdapter(this.store);
  }
}

/** Default fake reply so the panel is usable with no real dsh / API key. */
export const defaultResponder: Responder = async function* (content) {
  yield { type: "status", status: "running" };
  yield {
    type: "trace",
    step: {
      id: "step-1",
      kind: "step",
      title: "准备回复",
      status: "running",
    },
  };
  const reply = `这是 fake dsh 的回复。你刚才说：${content}`;
  const half = Math.ceil(reply.length / 2);
  yield { type: "assistant", delta: reply.slice(0, half) };
  yield { type: "assistant", delta: reply.slice(half) };
  yield {
    type: "trace",
    step: { id: "step-1", kind: "step", title: "准备回复", status: "completed" },
  };
  yield { type: "status", status: "idle" };
};
