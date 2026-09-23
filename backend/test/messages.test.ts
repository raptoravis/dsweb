import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { collectText, startTestServer, TestClient, type TestServer } from "./helpers.js";
import type { DshEvent } from "../src/dsh/types.js";

describe("messages + streaming + history (Seam 1)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  async function setup() {
    const c = new TestClient(server.baseUrl);
    await c.register("a@example.com", "password123");
    const conv = await c.createConversation("talk");
    return { c, id: conv.body.conversation.id, sessionId: server.db.getConversation(conv.body.conversation.id)!.dsh_session_id };
  }

  it("streams assistant chunk, trace step, tool result, and done in order", async () => {
    const { c, id, sessionId } = await setup();
    server.store.setResponder(sessionId, async function* (): AsyncGenerator<DshEvent> {
      yield { type: "status", status: "running" };
      yield { type: "assistant", delta: "hello " };
      yield { type: "assistant", delta: "world" };
      yield {
        type: "trace",
        step: { id: "t1", kind: "tool", title: "调用工具 read_file", status: "running", detail: { name: "read_file" } },
      };
      yield {
        type: "trace",
        step: { id: "t1", kind: "tool", title: "调用工具 read_file", status: "completed", detail: { output: "…" } },
      };
      yield { type: "done", messageId: "m1" };
    });

    const events = await c.sendMessage(id, "hi");
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["status", "assistant", "assistant", "trace", "trace", "done"]);
    assert.equal(collectText(events), "hello world");

    // The trace step carries both the running and completed states.
    const completed = events.find((e) => e.type === "trace" && e.step.status === "completed");
    assert.ok(completed);
    assert.equal((completed as any).step.kind, "tool");
  });

  it("returns full history (messages + trace) via GET", async () => {
    const { c, id, sessionId } = await setup();
    server.store.setResponder(sessionId, async function* (): AsyncGenerator<DshEvent> {
      yield { type: "assistant", delta: "answer" };
      yield {
        type: "trace",
        step: { id: "s1", kind: "step", title: "准备回复", status: "completed" },
      };
      yield { type: "done", messageId: "m1" };
    });

    await c.sendMessage(id, "question");

    const res = await c.getConversation(id);
    assert.equal(res.status, 200);
    const messages = res.body.messages as any[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "question");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "answer");
    assert.equal(messages[1].trace.length, 1);
    assert.equal(messages[1].trace[0].status, "completed");
  });

  it("rejects an empty message", async () => {
    const { c, id } = await setup();
    const res = await c.request("POST", `/api/conversations/${id}/messages`, { content: "   " });
    assert.equal(res.status, 400);
  });

  it("requires auth and ownership to send", async () => {
    const { id } = await setup();
    const stranger = new TestClient(server.baseUrl);
    await stranger.register("b@example.com", "password123");

    const anon = new TestClient(server.baseUrl);
    assert.equal((await anon.request("POST", `/api/conversations/${id}/messages`, { content: "x" })).status, 401);

    // Ownership: b cannot send into a's conversation.
    const res = await stranger.request("POST", `/api/conversations/${id}/messages`, { content: "x" });
    assert.equal(res.status, 404);
  });
});
