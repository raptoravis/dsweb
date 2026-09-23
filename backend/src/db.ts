import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TraceStep } from "./dsh/types.js";

/** A conversation's visible role for a stored message. */
export type MessageRole = "user" | "assistant";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  dsh_session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  trace: TraceStep[];
  created_at: number;
}

/**
 * Thin repository over a single SQLite file. Owns the schema and every query
 * the HTTP layer needs; it stores accounts, sessions, conversation metadata,
 * and the message/trace history that survives dsh process recycle.
 */
export class Db {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dsh_session_id  TEXT NOT NULL,
        title           TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_message_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        trace           TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----

  createUser(email: string, passwordHash: string): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      email,
      password_hash: passwordHash,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(row.id, row.email, row.password_hash, row.created_at);
    return row;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email) as UserRow | undefined;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
  }

  // ---- sessions ----

  createSession(userId: string, expiresAt: number): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, userId, Date.now(), expiresAt);
    return id;
  }

  getSessionUser(sessionId: string): UserRow | undefined {
    const session = this.db
      .prepare(
        "SELECT s.user_id, s.expires_at FROM sessions s WHERE s.id = ?",
      )
      .get(sessionId) as { user_id: string; expires_at: number } | undefined;
    if (!session || session.expires_at < Date.now()) return undefined;
    return this.getUserById(session.user_id);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  // ---- conversations ----

  createConversation(
    userId: string,
    dshSessionId: string,
    title: string,
  ): ConversationRow {
    const now = Date.now();
    const row: ConversationRow = {
      id: randomUUID(),
      user_id: userId,
      dsh_session_id: dshSessionId,
      title,
      created_at: now,
      updated_at: now,
      last_message_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, user_id, dsh_session_id, title, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.user_id,
        row.dsh_session_id,
        row.title,
        row.created_at,
        row.updated_at,
        row.last_message_at,
      );
    return row;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
  }

  listConversations(userId: string): ConversationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
          WHERE user_id = ?
          ORDER BY COALESCE(last_message_at, updated_at) DESC, created_at DESC, rowid DESC`,
      )
      .all(userId) as unknown as ConversationRow[];
  }

  renameConversation(id: string, title: string): void {
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), id);
  }

  touchConversation(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  deleteConversation(id: string): void {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  // ---- messages ----

  insertMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    trace: TraceStep[],
  ): MessageRow {
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: conversationId,
      role,
      content,
      trace,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, trace, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversation_id,
        row.role,
        row.content,
        JSON.stringify(row.trace),
        row.created_at,
      );
    return row;
  }

  listMessages(conversationId: string): MessageRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(conversationId) as Array<Omit<MessageRow, "trace"> & { trace: string }>;
    return rows.map((r) => ({ ...r, trace: JSON.parse(r.trace) as TraceStep[] }));
  }
}
