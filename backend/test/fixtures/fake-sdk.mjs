// Emulates `dsh --profile sdk` over stdio JSON-RPC for the thin adapter test.
// Speaks just enough of the wire protocol to exercise spawn/handshake/prompt
// and the event mapping, with no real dsh or API key required.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let promptCount = 0;

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (typeof id !== "number") return;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
        // Probe fields for the adapter test: prove the admin key and per-user
        // home reached the child env without echoing their values.
        keyPresent: process.env.DEEPSEEK_API_KEY === "secret-test-key",
        home: process.env.DSH_HOME,
      },
    });
    return;
  }

  if (method === "session/prompt") {
    send({ jsonrpc: "2.0", id, result: { messageId: `msg-${++promptCount}` } });
    const sessionId = params.sessionId;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "running" } });
      send({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          sessionId,
          event: {
            type: "assistant/message",
            seq: 1,
            time: Date.now(),
            data: { message: { content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }] } },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          sessionId,
          event: {
            type: "tool/call",
            seq: 2,
            time: Date.now(),
            data: { turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: "{}" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          sessionId,
          event: {
            type: "tool/result",
            seq: 3,
            time: Date.now(),
            data: {
              turn: 1,
              step: 1,
              message: { toolCallId: "call-1", content: [{ type: "text", text: "file content" }], isError: false },
            },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session.event",
        params: {
          sessionId,
          event: { type: "turn/end", seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
        },
      });
      send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "idle" } });
    }, 5);
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: {} });
    setTimeout(() => process.exit(0), 5);
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
