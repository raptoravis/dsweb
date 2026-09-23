import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, TestClient, type TestServer } from "./helpers.js";

describe("auth (Seam 1)", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it("registers, persists a session cookie, and resolves /me", async () => {
    const c = new TestClient(server.baseUrl);
    const reg = await c.register("a@example.com", "password123");
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, "a@example.com");
    assert.ok(reg.body.user.id);

    const me = await c.me();
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "a@example.com");
  });

  it("rejects a duplicate email", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("dup@example.com", "password123");
    const again = await c.register("dup@example.com", "password123");
    assert.equal(again.status, 409);
  });

  it("rejects malformed email and short password", async () => {
    const c = new TestClient(server.baseUrl);
    assert.equal((await c.register("nope", "password123")).status, 400);
    assert.equal((await c.register("ok@example.com", "short")).status, 400);
  });

  it("logs in with correct credentials and returns 401 on wrong password", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("b@example.com", "password123");

    const other = new TestClient(server.baseUrl);
    const bad = await other.login("b@example.com", "wrongpassword");
    assert.equal(bad.status, 401);

    const ok = await other.login("b@example.com", "password123");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, "b@example.com");
  });

  it("logs out and invalidates the session", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("c@example.com", "password123");
    assert.equal((await c.me()).status, 200);

    assert.equal((await c.logout()).status, 204);
    assert.equal((await c.me()).status, 401);
  });

  it("returns 401 for /me without a session", async () => {
    const c = new TestClient(server.baseUrl);
    assert.equal((await c.me()).status, 401);
  });

  it("stores a password hash, never the plaintext", async () => {
    const c = new TestClient(server.baseUrl);
    await c.register("d@example.com", "password123");
    const row = server.db.getUserByEmail("d@example.com");
    assert.ok(row);
    assert.ok(row.password_hash.startsWith("scrypt$"));
    assert.ok(!row.password_hash.includes("password123"));
  });
});
