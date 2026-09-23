import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  sendMessage,
  type Conversation,
  type Message,
  type TraceStep,
  type User,
} from "./api";
import { AuthForm } from "./components/AuthForm";
import { ConversationList } from "./components/ConversationList";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";

type Theme = "light" | "dark";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) ?? "light",
  );

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const activate = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState<{ content: string; trace: TraceStep[] } | null>(null);
  const [banner, setBanner] = useState("");

  const loadConversations = useCallback(async () => {
    try {
      const { conversations } = await api.listConversations();
      setConversations(conversations);
    } catch {
      // ignore transient list errors
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { user } = await api.me();
        setUser(user);
        await loadConversations();
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadConversations]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const selectConversation = async (id: string) => {
    activate(id);
    setMessages([]);
    setPending(null);
    try {
      const { messages } = await api.getConversation(id);
      if (activeIdRef.current === id) setMessages(messages);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "加载失败");
    }
  };

  const createConversation = async () => {
    try {
      const { conversation } = await api.createConversation();
      setConversations((prev) => [conversation, ...prev]);
      activate(conversation.id);
      setMessages([]);
      setPending(null);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "创建失败");
    }
  };

  const renameConversation = async (id: string, title: string) => {
    try {
      const { conversation } = await api.renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? conversation : c)));
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "重命名失败");
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        activate(null);
        setMessages([]);
        setPending(null);
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "删除失败");
    }
  };

  const send = async (content: string) => {
    const conversationId = activeId;
    if (!conversationId) return;
    setBanner("");
    const localUser: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content,
      trace: [],
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, localUser]);
    setStreaming(true);
    setPending({ content: "", trace: [] });

    let text = "";
    const trace: TraceStep[] = [];
    try {
      await sendMessage(conversationId, content, (ev) => {
        if (ev.type === "assistant") {
          text += ev.delta;
          setPending({ content: text, trace: [...trace] });
        } else if (ev.type === "trace") {
          const i = trace.findIndex((t) => t.id === ev.step.id);
          if (i >= 0) trace[i] = ev.step;
          else trace.push(ev.step);
          setPending({ content: text, trace: [...trace] });
        } else if (ev.type === "status") {
          setStreaming(ev.status === "running");
        }
      });
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "发送失败");
    } finally {
      setStreaming(false);
      setPending(null);
      try {
        const { messages } = await api.getConversation(conversationId);
        // Only reconcile if the user is still viewing this conversation.
        if (activeIdRef.current === conversationId) setMessages(messages);
      } catch {
        // keep the optimistic view on reconcile failure
      }
      await loadConversations();
    }
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
    setConversations([]);
    activate(null);
    setMessages([]);
  };

  if (loading) return <div className="empty-state">加载中…</div>;

  if (!user) {
    return (
      <div data-theme={theme}>
        <AuthForm
          onAuthed={(u) => {
            setUser(u);
            void loadConversations();
          }}
        />
      </div>
    );
  }

  return (
    <div data-theme={theme} className="panel">
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onCreate={createConversation}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      <main className="main">
        <div className="sidebar-header">
          <div className="account">
            <span>{user.email}</span>
            <span>
              <button
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              >
                {theme === "light" ? "深色" : "浅色"}
              </button>
              <button onClick={logout} className="danger">
                登出
              </button>
            </span>
          </div>
          {banner && <div className="auth-error">{banner}</div>}
        </div>
        {activeId ? (
          <>
            <MessageList messages={messages} pending={pending} />
            <Composer disabled={streaming} onSend={send} />
          </>
        ) : (
          <div className="empty-state">选择或新建一个对话开始</div>
        )}
      </main>
    </div>
  );
}
