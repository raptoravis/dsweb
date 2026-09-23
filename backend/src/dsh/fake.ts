import { randomUUID } from "node:crypto";
import { AsyncQueue } from "./async-queue.js";
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

function toAsyncIter(events: AsyncIterable<DshEvent> | DshEvent[]): AsyncIterable<DshEvent> {
  if (Symbol.asyncIterator in events) return events as AsyncIterable<DshEvent>;
  return (async function* () {
    yield* events as DshEvent[];
  })();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * In-memory session storage shared by every `FakeDshAdapter` instance, so
 * session state survives adapter recycle — the same way a real harness home
 * outlives its process. Because session ids are globally unique, the flat map
 * is naturally per-user isolated.
 */
export class FakeDshStore {
  private sessions = new Map<string, { queue: AsyncQueue<DshEvent> }>();
  private responders = new Map<string, Responder>();

  constructor(private readonly responder: Responder = defaultResponder) {}

  /** Script a specific session's next turns. */
  setResponder(sessionId: string, responder: Responder): void {
    this.responders.set(sessionId, responder);
  }

  responderFor(sessionId: string): Responder {
    return this.responders.get(sessionId) ?? this.responder;
  }

  ensure(sessionId: string): { queue: AsyncQueue<DshEvent> } {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { queue: new AsyncQueue<DshEvent>() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.queue.close();
    this.sessions.clear();
  }
}

/** The fake dsh runtime for one user's harness home. */
export class FakeDshAdapter implements DshAdapter {
  constructor(
    private readonly store: FakeDshStore,
    private readonly userHome: string,
  ) {}

  async prompt(sessionId: string, content: string): Promise<void> {
    const session = this.store.ensure(sessionId);
    const responder = this.store.responderFor(sessionId);
    void this.run(sessionId, session.queue, responder, content);
  }

  private async run(
    sessionId: string,
    queue: AsyncQueue<DshEvent>,
    responder: Responder,
    content: string,
  ): Promise<void> {
    try {
      for await (const event of toAsyncIter(responder(content))) {
        queue.push(event);
        if (event.type === "done" || event.type === "error") return;
      }
      queue.push({ type: "done", messageId: randomUUID() });
    } catch (err) {
      queue.push({ type: "error", message: errorMessage(err) });
    }
  }

  async *follow(sessionId: string): AsyncIterable<DshEvent> {
    const session = this.store.ensure(sessionId);
    for await (const event of session.queue) {
      yield event;
      if (event.type === "done" || event.type === "error") return;
    }
  }

  async close(): Promise<void> {
    // A real adapter would terminate its subprocess here. The fake shares its
    // store, so closing one handle must not drop the shared session state.
    void this.userHome;
  }
}

/** Factory for the fake adapter — the test double for the process manager. */
export class FakeAdapterFactory implements DshAdapterFactory {
  constructor(private readonly store: FakeDshStore) {}

  async create(userHome: string): Promise<DshAdapter> {
    return new FakeDshAdapter(this.store, userHome);
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
