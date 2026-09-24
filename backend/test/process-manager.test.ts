import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessManager } from "../src/dsh/process-manager.js";
import { FakeDshStore, FakeDshAdapter, FakeAdapterFactory } from "../src/dsh/fake.js";
import type { DshAdapter, DshAdapterFactory, DshEvent } from "../src/dsh/types.js";
import { startTestServer, TestClient } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function drain(iter: AsyncIterable<DshEvent>): Promise<DshEvent[]> {
  const events: DshEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

class CountingFactory implements DshAdapterFactory {
  created = 0;
  closed = 0;
  constructor(private readonly store: FakeDshStore) {}
  async create(): Promise<DshAdapter> {
    this.created++;
    const inner = new FakeDshAdapter(this.store);
    return {
      turn: (sid, c) => inner.turn(sid, c),
      close: async () => {
        this.closed++;
        await inner.close();
      },
    };
  }
}

describe("ProcessManager lifecycle", () => {
  it("lazily spawns, recycles on idle, and relaunches on reuse", async () => {
    const store = new FakeDshStore();
    const factory = new CountingFactory(store);
    const pm = new ProcessManager(factory, {
      idleTimeoutMs: 30,
      maxConcurrent: 64,
      homeBase: "/tmp/dsweb-pm-1",
    });

    assert.equal(pm.liveCount(), 0);
    assert.equal(factory.created, 0);

    await drain(pm.turn("u1", "s1", "hi"));
    assert.equal(pm.liveCount(), 1);
    assert.equal(factory.created, 1);

    await sleep(80); // idle timeout recycles
    assert.equal(pm.liveCount(), 0);
    assert.equal(factory.closed, 1);

    // Reuse relaunches the runtime.
    await drain(pm.turn("u1", "s1", "again"));
    assert.equal(pm.liveCount(), 1);
    assert.equal(factory.created, 2);

    await pm.closeAll();
  });

  it("evicts the least-recently-active idle user at the concurrency cap", async () => {
    const store = new FakeDshStore();
    const factory = new CountingFactory(store);
    const pm = new ProcessManager(factory, {
      idleTimeoutMs: 60_000,
      maxConcurrent: 2,
      homeBase: "/tmp/dsweb-pm-2",
    });

    await drain(pm.turn("u1", "s1", "x"));
    await drain(pm.turn("u2", "s2", "x"));
    assert.equal(pm.liveCount(), 2);

    // Third user forces an eviction of the LRU idle runtime (u1).
    await drain(pm.turn("u3", "s3", "x"));
    assert.equal(pm.liveCount(), 2);
    assert.equal(factory.created, 3);
    assert.equal(factory.closed, 1);

    await pm.closeAll();
  });

  it("never evicts a busy user, so one user cannot block another", async () => {
    const store = new FakeDshStore();
    const factory = new CountingFactory(store);
    const pm = new ProcessManager(factory, {
      idleTimeoutMs: 60_000,
      maxConcurrent: 1,
      homeBase: "/tmp/dsweb-pm-3",
    });

    // u1 has an open, never-ending turn (inflight > 0).
    store.setResponder("s1", async function* (): AsyncGenerator<DshEvent> {
      yield { type: "assistant", delta: "working…" };
      await new Promise(() => {});
    });
    const iterator = pm.turn("u1", "s1", "x")[Symbol.asyncIterator]();
    await iterator.next(); // consume the first event, keep the turn open

    // u2 must still be served even though u1 holds the only "slot".
    await drain(pm.turn("u2", "s2", "y"));
    assert.equal(pm.liveCount(), 2); // overshoot allowed; u1 not evicted

    await iterator.return?.();
    await pm.closeAll();
  });

  it("deduplicates concurrent spawns for the same new user", async () => {
    const store = new FakeDshStore();
    let created = 0;
    const slowFactory: DshAdapterFactory = {
      async create(): Promise<DshAdapter> {
        created++;
        await sleep(20);
        return new FakeDshAdapter(store);
      },
    };
    const pm = new ProcessManager(slowFactory, {
      idleTimeoutMs: 60_000,
      maxConcurrent: 64,
      homeBase: "/tmp/dsweb-pm-5",
    });

    await Promise.all([
      drain(pm.turn("u1", "s1", "a")),
      drain(pm.turn("u1", "s2", "b")),
    ]);
    assert.equal(created, 1); // both turns shared a single spawn

    await pm.closeAll();
  });

  it("serializes concurrent turns on the same session", async () => {
    const store = new FakeDshStore();
    const pm = new ProcessManager(new FakeAdapterFactory(store), {
      idleTimeoutMs: 60_000,
      maxConcurrent: 64,
      homeBase: "/tmp/dsweb-pm-4",
    });

    const releaseA = makeGate();
    const releaseB = makeGate();
    store.setResponder("s1", async function* (content: string): AsyncGenerator<DshEvent> {
      yield { type: "assistant", delta: content };
      await (content === "a" ? releaseA.promise : releaseB.promise);
      yield { type: "done", messageId: content };
    });

    const it1 = pm.turn("u1", "s1", "a")[Symbol.asyncIterator]();
    const first1 = await it1.next();
    assert.equal((first1.value as { delta: string }).delta, "a");
    const pendingDone1 = it1.next(); // resume turn 1 into its blocked await

    const it2 = pm.turn("u1", "s1", "b")[Symbol.asyncIterator]();
    let secondStarted = false;
    const pendingFirst2 = it2.next().then((r) => {
      secondStarted = true;
      return r;
    });

    await sleep(20);
    assert.equal(secondStarted, false); // turn 2 waits for turn 1 to finish

    releaseA.resolve();
    const done1 = await pendingDone1;
    assert.equal((done1.value as { type: string }).type, "done");
    await it1.next(); // fully drain turn 1 → releases the session gate

    const first2 = await pendingFirst2;
    assert.equal((first2.value as { delta: string }).delta, "b");

    const pendingDone2 = it2.next();
    releaseB.resolve();
    const done2 = await pendingDone2;
    assert.equal((done2.value as { type: string }).type, "done");
    await it2.next();

    await pm.closeAll();
  });
});

describe("ProcessManager recycle through the HTTP API", () => {
  it("retains history across idle recycle and relaunch", async () => {
    const server = await startTestServer({ idleTimeoutMs: 40 });
    try {
      const c = new TestClient(server.baseUrl);
      await c.register("a@example.com", "password123");
      const conv = await c.createConversation("recycle");
      const id = conv.body.conversation.id;

      await c.sendMessage(id, "first");
      assert.equal(server.dsh.liveCount(), 1);

      await sleep(100); // idle recycle
      assert.equal(server.dsh.liveCount(), 0);

      await c.sendMessage(id, "second");
      assert.equal(server.dsh.liveCount(), 1);

      const res = await c.getConversation(id);
      const roles = res.body.messages.map((m: any) => m.role);
      assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
    } finally {
      await server.close();
    }
  });
});
