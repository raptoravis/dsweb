import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessManager } from "../src/dsh/process-manager.js";
import { FakeDshStore, FakeDshAdapter } from "../src/dsh/fake.js";
import type { DshAdapter, DshAdapterFactory, DshEvent } from "../src/dsh/types.js";
import { startTestServer, TestClient } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  async create(userHome: string): Promise<DshAdapter> {
    this.created++;
    const inner = new FakeDshAdapter(this.store, userHome);
    return {
      prompt: (sid, c) => inner.prompt(sid, c),
      follow: (sid) => inner.follow(sid),
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

    await pm.prompt("u1", "s1", "hi");
    assert.equal(pm.liveCount(), 1);
    assert.equal(factory.created, 1);

    await drain(pm.follow("u1", "s1"));

    await sleep(80); // idle timeout recycles
    assert.equal(pm.liveCount(), 0);
    assert.equal(factory.closed, 1);

    // Reuse relaunches the runtime.
    await pm.prompt("u1", "s1", "again");
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

    await pm.prompt("u1", "s1", "x");
    await drain(pm.follow("u1", "s1"));
    await pm.prompt("u2", "s2", "x");
    await drain(pm.follow("u2", "s2"));
    assert.equal(pm.liveCount(), 2);

    // Third user forces an eviction of the LRU idle runtime (u1).
    await pm.prompt("u3", "s3", "x");
    await drain(pm.follow("u3", "s3"));
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

    // u1 has an open, never-ending stream (inflight > 0).
    store.setResponder("s1", async function* (): AsyncGenerator<DshEvent> {
      yield { type: "assistant", delta: "working…" };
      await new Promise(() => {});
    });
    await pm.prompt("u1", "s1", "x");
    const iterator = pm.follow("u1", "s1")[Symbol.asyncIterator]();
    await iterator.next(); // consume the first event, keep the stream open

    // u2 must still be served even though u1 holds the only "slot".
    await pm.prompt("u2", "s2", "y");
    assert.equal(pm.liveCount(), 2); // overshoot allowed; u1 not evicted

    await iterator.return?.();
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
