import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sleep, startTestServer, TestClient, type TestServer } from "./helpers.js";

describe("conversation CRUD (Seam 1)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates a conversation with a default title and returns id + title", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("a@example.com", "password123");

    const created = await c.createConversation();
    assert.equal(created.status, 201);
    assert.ok(created.body.conversation.id);
    assert.equal(created.body.conversation.title, "新对话");
  });

  it("lists only the current user's conversations, ordered by recent activity", async () => {
    const a = new TestClient(server.baseUrl);
    await a.register("a@example.com", "password123");
    const b = new TestClient(server.baseUrl);
    await b.register("b@example.com", "password123");

    await a.createConversation("A1");
    await b.createConversation("B1");
    await sleep(5);
    await a.createConversation("A2");

    const list = await a.listConversations();
    assert.equal(list.status, 200);
    const titles = list.body.conversations.map((c: any) => c.title);
    // Most recent first.
    assert.deepEqual(titles, ["A2", "A1"]);
    // No cross-user leakage.
    assert.ok(!titles.includes("B1"));
  });

  it("renames a conversation", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("c@example.com", "password123");
    const created = await c.createConversation("Old");
    const id = created.body.conversation.id;

    const renamed = await c.rename(id, "New title");
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.conversation.title, "New title");

    assert.equal((await c.rename(id, "   ")).status, 400);
  });

  it("deletes a conversation", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("d@example.com", "password123");
    const created = await c.createConversation("To delete");
    const id = created.body.conversation.id;

    assert.equal((await c.delete(id)).status, 204);
    assert.equal((await c.getConversation(id)).status, 404);
  });

  it("returns 404 when accessing another user's conversation", async () => {
    const a = new TestClient(server.baseUrl);
    await a.register("a@example.com", "password123");
    const b = new TestClient(server.baseUrl);
    await b.register("b@example.com", "password123");

    const conv = await a.createConversation("private");
    const id = conv.body.conversation.id;

    assert.equal((await b.getConversation(id)).status, 404);
    assert.equal((await b.rename(id, "hack")).status, 404);
    assert.equal((await b.delete(id)).status, 404);
  });

  it("requires auth for all conversation routes", async () => {
    const c = new TestClient(server.baseUrl);
    assert.equal((await c.listConversations()).status, 401);
    assert.equal((await c.createConversation()).status, 401);
  });
});
