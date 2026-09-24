import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealDshAdapter } from "../src/dsh/real.js";
import type { DshEvent } from "../src/dsh/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeSdk = join(here, "fixtures", "fake-sdk.mjs");

describe("RealDshAdapter (thin test against a fake SDK)", () => {
  it("handshakes, prompts, and maps session events to panel events", async () => {
    const adapter = new RealDshAdapter({
      command: [process.execPath, fakeSdk],
      provider: "deepseek-official",
      model: "deepseek-flash",
      userHome: "/tmp/dsweb-real-test",
    });
    try {
      const events: DshEvent[] = [];
      for await (const event of adapter.turn("session-1", "hello")) {
        events.push(event);
        if (event.type === "done") break;
      }

      const text = events
        .filter((e): e is Extract<DshEvent, { type: "assistant" }> => e.type === "assistant")
        .map((e) => e.delta)
        .join("");
      assert.equal(text, "hello world");

      const tool = events.find(
        (e): e is Extract<DshEvent, { type: "trace" }> => e.type === "trace" && e.step.status === "completed",
      );
      assert.ok(tool);
      assert.equal(tool.step.title, "工具结果");
      assert.ok(events.some((e) => e.type === "done"));
    } finally {
      await adapter.close();
    }
  });

  it("injects the admin key and per-user home into the child env only", async () => {
    const adapter = new RealDshAdapter({
      command: [process.execPath, fakeSdk],
      provider: "deepseek-official",
      model: "deepseek-flash",
      apiKey: "secret-test-key",
      userHome: "/tmp/dsweb-home-user1",
    });
    try {
      await adapter.waitReady();
      const result = adapter.initializeResult as { keyPresent?: boolean; home?: string };
      assert.equal(result.keyPresent, true);
      assert.equal(result.home, "/tmp/dsweb-home-user1");
    } finally {
      await adapter.close();
    }
  });
});
