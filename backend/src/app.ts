import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomUUID } from "node:crypto";
import {
  hashPassword,
  isEmail,
  isValidPassword,
  sessionExpiry,
  verifyPassword,
} from "./auth.js";
import { Db, type UserRow } from "./db.js";
import type { DshEvent, DshService, TraceStep } from "./dsh/types.js";
import { sseFrame, sseHeaders } from "./sse.js";

const SESSION_COOKIE = "sid";

export interface AuthRequest extends Request {
  user?: UserRow;
}

function publicUser(user: UserRow): { id: string; email: string } {
  return { id: user.id, email: user.email };
}

function publicConversation(conv: {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
}): {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
} {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    lastMessageAt: conv.last_message_at,
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore malformed cookie values rather than failing the request
    }
  }
  return out;
}

function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Build the HTTP app (Seam 1) against a DB and a dsh service (Seam 2). */
export function createApp(db: Db, dsh: DshService): express.Express {
  const app = express();
  app.use(express.json());

  const authRequired = (req: AuthRequest, res: Response, next: NextFunction): void => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? db.getSessionUser(token) : undefined;
    if (!user) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    req.user = user;
    next();
  };

  const ownConversation = (req: AuthRequest, res: Response) => {
    const conv = db.getConversation(req.params.id ?? "");
    if (!conv || conv.user_id !== req.user!.id) {
      res.status(404).json({ error: "对话不存在" });
      return null;
    }
    return conv;
  };

  // ---- auth ----

  app.post("/api/auth/register", (req: AuthRequest, res: Response) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!isEmail(email)) {
      res.status(400).json({ error: "邮箱格式不正确" });
      return;
    }
    if (!isValidPassword(password)) {
      res.status(400).json({ error: "密码至少 8 位" });
      return;
    }
    if (db.getUserByEmail(email)) {
      res.status(409).json({ error: "该邮箱已注册" });
      return;
    }
    const user = db.createUser(email, hashPassword(password));
    const token = db.createSession(user.id, sessionExpiry());
    setSessionCookie(res, token);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post("/api/auth/login", (req: AuthRequest, res: Response) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = db.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "邮箱或密码错误" });
      return;
    }
    const token = db.createSession(user.id, sessionExpiry());
    setSessionCookie(res, token);
    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req: AuthRequest, res: Response) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.deleteSession(token);
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/auth/me", authRequired, (req: AuthRequest, res: Response) => {
    res.json({ user: publicUser(req.user!) });
  });

  // ---- conversations ----

  app.get("/api/conversations", authRequired, (req: AuthRequest, res: Response) => {
    const conversations = db.listConversations(req.user!.id).map(publicConversation);
    res.json({ conversations });
  });

  app.post("/api/conversations", authRequired, (req: AuthRequest, res: Response) => {
    const title =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim()
        : "新对话";
    const conv = db.createConversation(req.user!.id, randomUUID(), title);
    res.status(201).json({ conversation: publicConversation(conv) });
  });

  app.get("/api/conversations/:id", authRequired, (req: AuthRequest, res: Response) => {
    const conv = ownConversation(req, res);
    if (!conv) return;
    const messages = db.listMessages(conv.id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      trace: m.trace,
      createdAt: m.created_at,
    }));
    res.json({ conversation: publicConversation(conv), messages });
  });

  app.patch("/api/conversations/:id", authRequired, (req: AuthRequest, res: Response) => {
    const conv = ownConversation(req, res);
    if (!conv) return;
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "标题不能为空" });
      return;
    }
    db.renameConversation(conv.id, title);
    res.json({ conversation: publicConversation(db.getConversation(conv.id)!) });
  });

  app.delete("/api/conversations/:id", authRequired, (req: AuthRequest, res: Response) => {
    const conv = ownConversation(req, res);
    if (!conv) return;
    db.deleteConversation(conv.id);
    res.status(204).end();
  });

  // ---- messages (SSE) ----

  app.post("/api/conversations/:id/messages", authRequired, async (req: AuthRequest, res: Response) => {
    const conv = ownConversation(req, res);
    if (!conv) return;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }

    db.insertMessage(conv.id, "user", content, []);
    db.touchConversation(conv.id);

    try {
      await dsh.prompt(req.user!.id, conv.dsh_session_id, content);
    } catch (err) {
      res.status(502).json({ error: "agent 引擎不可用" });
      return;
    }

    res.status(200);
    res.set(sseHeaders);
    res.flushHeaders();

    let text = "";
    const trace: TraceStep[] = [];
    const upsertTrace = (step: TraceStep): void => {
      const i = trace.findIndex((t) => t.id === step.id);
      if (i >= 0) trace[i] = step;
      else trace.push(step);
    };
    // A dropped client must not abort the turn: keep consuming and persisting
    // so the in-flight reply still lands in history (recoverable, not lost).
    const writable = (): boolean => !res.destroyed && !res.writableEnded;

    try {
      const events = dsh.follow(req.user!.id, conv.dsh_session_id);
      for await (const event of events) {
        if (writable()) res.write(sseFrame(event));
        if (event.type === "assistant") text += event.delta;
        else if (event.type === "trace") upsertTrace(event.step);
        else if (event.type === "done") {
          if (text.trim() || trace.length > 0) {
            db.insertMessage(conv.id, "assistant", text, trace);
          }
          db.touchConversation(conv.id);
          break;
        } else if (event.type === "error") {
          db.insertMessage(conv.id, "assistant", text, [
            ...trace,
            { id: "error", kind: "step", title: "错误", status: "error", detail: { message: event.message } },
          ]);
          db.touchConversation(conv.id);
          break;
        }
      }
    } finally {
      res.end();
    }
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[dsweb] unhandled error:", err);
    res.status(500).json({ error: "服务器内部错误" });
  });

  return app;
}
