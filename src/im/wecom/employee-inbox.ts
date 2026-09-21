import { CliFailure } from './employee-client.js';
import type { WecomConfig } from './config.js';
import type { WecomStore } from './store.js';
import { isAllowed, stableKey, type WecomMessage } from './message.js';

export interface MessageQuery { chat_id: string; begin_time: string; end_time: string; cursor?: string }
export interface MessagePage { messages: Record<string, unknown>[]; has_more: boolean; next_cursor?: string }
export interface EmployeeApi {
  identity(): Promise<{ userId: string; name: string }>;
  read(query: MessageQuery): Promise<MessagePage>;
}
export function wecomTime(ms: number): string {
  // The CLI's current chat API uses mainland China wall-clock strings (no offset field).
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
function sentAt(row: Record<string, unknown>): number {
  if (typeof row.send_time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.send_time)) throw new Error('员工消息缺少有效时间');
  const time = Date.parse(row.send_time.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(time)) throw new Error('员工消息时间无效');
  return time;
}

export class EmployeeInbox {
  readonly accountId: string;
  private stopped = false;
  stop(): void { this.stopped = true; }
  constructor(private config: WecomConfig, private store: WecomStore, private api: EmployeeApi,
    private accept: (message: WecomMessage) => Promise<void>, private now: () => number = Date.now) {
    this.accountId = `employee:${config.employee!.userId}`;
  }
  async initialize(): Promise<void> {
    await this.assertIdentity();
    for (const chat of this.config.employee!.chats) {
      const key = `employee:${chat.chatType}:${chat.chatId}`;
      const watermark = this.store.getCheckpoint(key) ?? String(Math.floor(this.now() / 1000) * 1000);
      if (!Number.isFinite(Number(watermark))) throw new Error('员工消息水位无效');
      this.store.setCheckpoint(key, watermark);
      if (!this.store.getCheckpoint(`${key}:start`)) this.store.setCheckpoint(`${key}:start`, watermark);
    }
  }
  private async assertIdentity(): Promise<void> {
    if ((await this.api.identity()).userId !== this.config.employee!.userId) throw new Error('授权员工身份改变，拒绝收发');
  }
  async poll(): Promise<void> {
    if (this.stopped) return;
    await this.assertIdentity();
    const employee = this.config.employee!;
    const end = Math.floor(this.now() / 1000) * 1000 - 1000;
    let failed: unknown;
    for (const chat of employee.chats) {
      if (this.stopped) return;
      try {
        const key = `employee:${chat.chatType}:${chat.chatId}`;
        const saved = this.store.getCheckpoint(key), start = Number(this.store.getCheckpoint(`${key}:start`));
        if (saved === undefined || !Number.isFinite(start)) throw new Error('员工收件尚未初始化');
        const watermark = Number(saved);
        if (end < watermark) continue;
        if (end - watermark > 7 * 86400000 - employee.overlapMs) throw new Error('员工消息中断超过查询窗口，需人工处理历史缺口');
        const begin = Math.max(start, watermark - employee.overlapMs);
        if (begin >= end) continue;
        const rows: Record<string, unknown>[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; ; page++) {
          const result = await this.api.read({ chat_id: chat.chatId, begin_time: wecomTime(begin), end_time: wecomTime(end), ...(cursor ? { cursor } : {}) });
          if (this.stopped) return;
          if (!Array.isArray(result.messages) || typeof result.has_more !== 'boolean') throw new Error('员工消息分页响应无效');
          rows.push(...result.messages);
          if (rows.length > 10000) throw new Error('员工消息分页过大，水位未推进');
          if (!result.has_more) break;
          if (page >= 99 || !result.next_cursor || cursors.has(result.next_cursor)) throw new Error('员工消息分页游标无效或超限');
          cursor = result.next_cursor; cursors.add(cursor);
        }
        rows.sort((a, b) => sentAt(a) - sentAt(b));
        const occurrences = new Map<string, number>();
        for (const row of rows) {
          if (this.stopped) return;
          const time = sentAt(row);
          if (time < start || time > end) continue;
          if (typeof row.userid !== 'string' || row.msg_type !== 'text') continue;
          const text = (row.text as { content?: unknown } | undefined)?.content;
          if (typeof text !== 'string') continue;
          const fingerprint = stableKey(this.accountId, chat.chatType, chat.chatId, row.userid, String(time), text);
          const occurrence = (occurrences.get(fingerprint) ?? 0) + 1; occurrences.set(fingerprint, occurrence);
          const own = row.userid === employee.userId;
          // Self-generated replies never trigger another task. Own explicit commands permit safe testing.
          const prefix = own ? employee.ownMessagePrefix : chat.prefix ?? (chat.chatType === 'group' ? '/codex ' : '');
          if (prefix && !text.startsWith(prefix)) continue;
          if (chat.chatType === 'single' && !own && row.userid !== chat.chatId) continue;
          const message: WecomMessage = { botId: this.accountId, msgId: `${fingerprint}:${occurrence}`, reqId: `${fingerprint}:${occurrence}`,
            chatType: chat.chatType, chatId: chat.chatId, senderId: row.userid, kind: 'text', text: text.slice(prefix.length) };
          if (isAllowed(message, this.config)) await this.accept(message);
        }
        // Persist only after all pages are durably accepted. Crash/retry reuses the same message fingerprints.
        if (this.stopped) return;
        this.store.setCheckpoint(key, String(end));
      } catch (error) {
        // A missing/forbidden chat must not starve other configured conversations.
        // Global backpressure and an unfillable history gap stop the entire poll.
        if (error instanceof CliFailure && error.outcome === 'retryable'
          || error instanceof Error && error.message.includes('历史缺口')) throw error;
        failed ??= error;
      }
    }
    if (failed) throw failed;
  }
}
