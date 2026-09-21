import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../../services/sqlite-compat.js';
import type { TriggerRequest } from '../../services/trigger-types.js';
import { conversationKey, type WecomMessage } from './message.js';

export type WorkPhase = 'queued' | 'submitting' | 'running' | 'completed' | 'failed' | 'command';
export interface WorkItem {
  id: number; conversationKey: string; message: WecomMessage; phase: WorkPhase;
  request: TriggerRequest | null; sessionId: string | null; triggerId: string | null;
  result: string | null; createdAt: number; submittedAt: number | null;
  nextAt: number; attempts: number; timeoutNotified: number;
}
export interface Conversation { key: string; sessionId: string | null; blocked: number; generation: number }
export interface OutboxItem {
  id: number; messageId: number; content: string; kind: 'reply' | 'send';
  state: 'pending' | 'sending' | 'sent' | 'unknown' | 'failed';
  attempts: number; nextAt: number; message: WecomMessage; conversationKey: string;
}

export class WecomStore {
  private db: DatabaseSyncLike;
  private closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDatabaseSyncOrThrow(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, sessionId TEXT, blocked INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, botId TEXT NOT NULL, msgId TEXT NOT NULL, conversationKey TEXT NOT NULL,
        message TEXT NOT NULL, phase TEXT NOT NULL, request TEXT, sessionId TEXT, triggerId TEXT, result TEXT,
        createdAt INTEGER NOT NULL, submittedAt INTEGER, nextAt INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, timeoutNotified INTEGER NOT NULL DEFAULT 0, UNIQUE(botId,msgId));
      CREATE INDEX IF NOT EXISTS message_queue ON messages(conversationKey,phase,id);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, messageId INTEGER NOT NULL, ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, UNIQUE(messageId,ordinal));
      CREATE TABLE IF NOT EXISTS send_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, conversationKey TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS send_window ON send_attempts(conversationKey,at);`);
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
  getCheckpoint(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(`checkpoint:${key}`) as { value: string } | undefined)?.value;
  }
  setCheckpoint(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`checkpoint:${key}`, value);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bindBot(botId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='bot'").get() as { value: string } | undefined;
      if (row && row.value !== botId) throw new Error('企微状态目录属于另一个机器人');
      this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('bot',?)").run(botId);
    });
  }
  private work(raw: unknown): WorkItem | null {
    if (!raw) return null;
    const row = raw as Omit<WorkItem, 'message' | 'request'> & { message: string; request: string | null };
    return { ...row, message: JSON.parse(row.message), request: row.request ? JSON.parse(row.request) : null };
  }
  getMessage(id: number): WorkItem | null { return this.work(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
  getConversation(key: string): Conversation | null {
    return this.db.prepare('SELECT * FROM conversations WHERE key=?').get(key) as Conversation ?? null;
  }
  enqueue(message: WecomMessage, maxQueued: number, now: number, command = false): WorkItem | null {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM messages WHERE botId=? AND msgId=?').get(message.botId, message.msgId)) return null;
      const key = conversationKey(message);
      this.db.prepare('INSERT OR IGNORE INTO conversations(key) VALUES(?)').run(key);
      const pending = this.pendingCount(key);
      const blocked = this.getConversation(key)!.blocked;
      const notice = !command && blocked ? '会话需要管理员处理，请使用 /status 查看，空闲时用 /new 新建会话。'
        : !command && pending >= maxQueued ? '本会话队列已满，请稍后重试。' : null;
      const r = this.db.prepare('INSERT INTO messages(botId,msgId,conversationKey,message,phase,result,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(message.botId, message.msgId, key, JSON.stringify(message), command || notice ? 'command' : 'queued', notice, now);
      return this.getMessage(Number(r.lastInsertRowid));
    });
  }
  pendingCount(key: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM messages WHERE conversationKey=? AND phase IN ('queued','submitting','running')").get(key) as { n: number }).n;
  }
  active(): WorkItem[] {
    return this.db.prepare("SELECT * FROM messages WHERE phase IN ('submitting','running') ORDER BY id").all().map(r => this.work(r)!);
  }
  ready(now: number, limit: number): WorkItem[] {
    return this.db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.key=m.conversationKey
      WHERE m.phase='queued' AND c.blocked=0 AND m.nextAt<=?
      AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.conversationKey=m.conversationKey
        AND p.phase IN ('queued','submitting','running') AND p.id<m.id)
      ORDER BY m.id LIMIT ?`).all(now, limit).map(r => this.work(r)!);
  }
  prepareSubmission(id: number, request: TriggerRequest, now: number): void {
    this.db.prepare("UPDATE messages SET phase='submitting',request=?,submittedAt=? WHERE id=? AND phase='queued'")
      .run(JSON.stringify(request), now, id);
  }
  bind(id: number, sessionId: string, triggerId: string): void {
    this.transaction(() => {
      const row = this.getMessage(id)!;
      this.db.prepare("UPDATE messages SET phase='running',sessionId=?,triggerId=?,attempts=0,nextAt=0 WHERE id=?").run(sessionId, triggerId, id);
      this.db.prepare('UPDATE conversations SET sessionId=? WHERE key=?').run(sessionId, row.conversationKey);
    });
  }
  defer(id: number, nextAt: number): void { this.db.prepare('UPDATE messages SET nextAt=?,attempts=attempts+1 WHERE id=?').run(nextAt, id); }
  noteTimeout(id: number): void { this.db.prepare('UPDATE messages SET timeoutNotified=1 WHERE id=?').run(id); }
  addReply(id: number, content: string): void {
    this.db.prepare("INSERT OR IGNORE INTO outbox(messageId,ordinal,kind,content) VALUES(?,-1,'reply',?)").run(id, content);
  }
  finish(id: number, phase: 'completed' | 'failed' | 'command', result: string, chunks: string[]): void {
    this.transaction(() => {
      this.db.prepare('UPDATE messages SET phase=?,result=? WHERE id=?').run(phase, result, id);
      for (const [index, content] of chunks.entries()) this.db.prepare("INSERT OR IGNORE INTO outbox(messageId,ordinal,kind,content) VALUES(?,?,'send',?)").run(id, index, content);
    });
  }
  failConversation(id: number, result: string, chunks: (row: WorkItem, text: string) => string[]): void {
    this.transaction(() => {
      const row = this.getMessage(id)!;
      this.db.prepare('UPDATE conversations SET blocked=1 WHERE key=?').run(row.conversationKey);
      const pending = this.db.prepare("SELECT * FROM messages WHERE conversationKey=? AND phase='queued' AND id<>? ORDER BY id")
        .all(row.conversationKey, id).map(r => this.work(r)!);
      for (const item of [row, ...pending]) {
        const text = item.id === id ? result : '前一任务失败，会话已暂停，本任务未执行。';
        this.db.prepare("UPDATE messages SET phase='failed',result=? WHERE id=?").run(text, item.id);
        for (const [ordinal, content] of chunks(item, text).entries()) {
          this.db.prepare("INSERT OR IGNORE INTO outbox(messageId,ordinal,kind,content) VALUES(?,?,'send',?)").run(item.id, ordinal, content);
        }
      }
    });
  }
  reset(key: string): boolean {
    return this.transaction(() => {
      if (this.pendingCount(key)) return false;
      this.db.prepare('UPDATE conversations SET sessionId=NULL,blocked=0,generation=generation+1 WHERE key=?').run(key);
      return true;
    });
  }
  latest(key: string, excluding: number): WorkItem | null {
    return this.work(this.db.prepare("SELECT * FROM messages WHERE conversationKey=? AND id<>? AND phase<>'command' ORDER BY id DESC LIMIT 1").get(key, excluding));
  }
  private outbox(rows: unknown[]): OutboxItem[] {
    return rows.map(raw => { const row = raw as OutboxItem & { message: string }; return { ...row, message: JSON.parse(row.message) }; });
  }
  outboxFor(id: number): OutboxItem[] {
    return this.outbox(this.db.prepare('SELECT o.*,m.message,m.conversationKey FROM outbox o JOIN messages m ON m.id=o.messageId WHERE messageId=? ORDER BY ordinal').all(id));
  }
  pendingOutbox(now: number): OutboxItem[] {
    // Select each eligible conversation's head before limiting the batch: one
    // group's long answer or exhausted quota must not block unrelated groups.
    return this.outbox(this.db.prepare(`WITH candidates AS (
      SELECT o.*,m.message,m.conversationKey,
        ROW_NUMBER() OVER (PARTITION BY m.conversationKey ORDER BY CASE o.kind WHEN 'send' THEN 0 ELSE 1 END,o.id) AS position
      FROM outbox o JOIN messages m ON m.id=o.messageId
      WHERE o.state='pending' AND o.nextAt<=?
        AND (SELECT count(*) FROM send_attempts a WHERE a.conversationKey=m.conversationKey AND a.at>?)<20
        AND (SELECT count(*) FROM send_attempts a WHERE a.conversationKey=m.conversationKey AND a.at>=?)<800)
      SELECT * FROM candidates WHERE position=1
      ORDER BY CASE kind WHEN 'send' THEN 0 ELSE 1 END,id LIMIT 100`).all(now, now - 60000, now - 3600000));
  }
  recoverSending(): void { this.db.exec("UPDATE outbox SET state='unknown' WHERE state='sending'"); }
  canSend(key: string, now: number): boolean {
    this.db.prepare('DELETE FROM send_attempts WHERE at<?').run(now - 3600000);
    const rows = this.db.prepare('SELECT at FROM send_attempts WHERE conversationKey=?').all(key) as { at: number }[];
    return rows.length < 800 && rows.filter(r => r.at > now - 60000).length < 20;
  }
  markSending(id: number, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(id);
      this.db.prepare('INSERT INTO send_attempts(conversationKey,at) SELECT m.conversationKey,? FROM messages m JOIN outbox o ON o.messageId=m.id WHERE o.id=?').run(now, id);
    });
  }
  markDelivery(id: number, state: OutboxItem['state'], nextAt = 0): void {
    this.db.prepare('UPDATE outbox SET state=?,nextAt=? WHERE id=?').run(state, nextAt, id);
  }
}
