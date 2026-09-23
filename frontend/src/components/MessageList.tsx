import type { Message, TraceStep } from "../api";
import { TraceView } from "./TraceView";

interface Props {
  messages: Message[];
  /** In-flight assistant text + trace while streaming. */
  pending: { content: string; trace: TraceStep[] } | null;
}

export function MessageList({ messages, pending }: Props) {
  return (
    <div className="message-list">
      {messages.map((m) => (
        <div key={m.id} className={`message ${m.role}`}>
          <div className="bubble">{m.content}</div>
          {m.role === "assistant" && <TraceView steps={m.trace} />}
        </div>
      ))}
      {pending && (
        <div className="message assistant">
          <div className="bubble">
            {pending.content}
            <span className="cursor">▍</span>
          </div>
          <TraceView steps={pending.trace} />
        </div>
      )}
    </div>
  );
}
