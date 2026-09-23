import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RealDshAdapter } from "../src/dsh/real.js";

/**
 * Tagged smoke test against a real dsh + DeepSeek key. Runs only when
 * `DSH_SMOKE=1` is set (dedicated environment); skipped in regular CI so the
 * suite never needs a real agent or credentials.
 */
const enabled = process.env.DSH_SMOKE === "1";

describe("real dsh smoke (dedicated env only)", () => {
  it(
    "drives a real agent to produce a reply",
    { skip: !enabled },
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      assert.ok(apiKey, "DEEPSEEK_API_KEY is required for the smoke test");

      const adapter = new RealDshAdapter({
        command: [process.env.DSH_BIN ?? "dsh", "--profile", "sdk"],
        provider: process.env.DSH_PROVIDER ?? "deepseek-official",
        model: process.env.DSH_MODEL ?? "deepseek-flash",
        apiKey,
        userHome: process.env.DSH_SMOKE_HOME ?? "/tmp/dsweb-smoke-home",
      });
      try {
        const sessionId = `smoke-${Date.now()}`;
        await adapter.prompt(sessionId, '只回复两个汉字："好的"。');
        let text = "";
        for await (const event of adapter.follow(sessionId)) {
          if (event.type === "assistant") text += event.delta;
          else if (event.type === "done") break;
          else if (event.type === "error") throw new Error(event.message);
        }
        assert.ok(text.trim().length > 0, "expected a non-empty assistant reply");
      } finally {
        await adapter.close();
      }
    },
  );
});
