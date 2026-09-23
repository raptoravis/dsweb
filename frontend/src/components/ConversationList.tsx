import { useState } from "react";
import type { Conversation } from "../api";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function formatTime(ts: number | null): string {
  if (ts == null) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setDraft(c.title);
  };

  const commitRename = () => {
    if (editingId && draft.trim()) {
      onRename(editingId, draft.trim());
    }
    setEditingId(null);
    setDraft("");
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button className="primary" onClick={onCreate}>
          + 新建对话
        </button>
      </div>
      <div className="conversation-list">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`conversation-item ${c.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(c.id)}
          >
            <div className="title-row">
              {editingId === c.id ? (
                <input
                  value={draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <span className="title">{c.title}</span>
              )}
              <span className="time">{formatTime(c.lastMessageAt ?? c.updatedAt)}</span>
            </div>
            <div className="actions">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(c);
                }}
              >
                重命名
              </button>
              <button
                className="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {conversations.length === 0 && (
          <div className="empty-state">还没有对话</div>
        )}
      </div>
    </aside>
  );
}
