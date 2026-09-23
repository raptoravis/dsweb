import { useState, type FormEvent } from "react";
import { api, type User } from "../api";

interface Props {
  onAuthed: (user: User) => void;
}

export function AuthForm({ onAuthed }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login(email, password)
          : await api.register(email, password);
      onAuthed(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>{mode === "login" ? "登录" : "注册"}</h1>
        <input
          type="email"
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          type="password"
          placeholder="密码（至少 8 位）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
        <div className="auth-error">{error}</div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
        </button>
      </form>
    </div>
  );
}
