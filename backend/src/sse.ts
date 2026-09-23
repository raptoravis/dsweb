import type { DshEvent } from "./dsh/types.js";

/** Serialize one event as an SSE frame (`event:` name + `data:` JSON). */
export function sseFrame(event: DshEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Headers for a text/event-stream response. */
export const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
