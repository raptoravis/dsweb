import { useState, type KeyboardEvent } from "react";

interface Props {
  disabled: boolean;
  onSend: (content: string) => void;
}

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState("");

  const send = () => {
    const content = text.trim();
    if (!content || disabled) return;
    onSend(content);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button className="primary" onClick={send} disabled={disabled || !text.trim()}>
        发送
      </button>
    </div>
  );
}
