import { createHash } from 'node:crypto';

export interface WecomMessage {
  botId: string;
  msgId: string;
  reqId: string;
  chatType: 'single' | 'group';
  chatId: string;
  senderId: string;
  kind: 'text' | 'unsupported';
  text: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

export function normalizeMessage(frame: unknown, botId: string): WecomMessage | null {
  const f = record(frame), body = record(f?.body), headers = record(f?.headers);
  const senderId = record(body?.from)?.userid;
  if (!body || body.aibotid !== botId || !id(body.msgid) || !id(headers?.req_id) || !id(senderId)) return null;
  if (body.chattype !== 'single' && body.chattype !== 'group') return null;
  const chatId = body.chattype === 'single' ? senderId : body.chatid;
  if (!id(chatId)) return null;
  const content = record(body.text)?.content;
  const isText = body.msgtype === 'text' && typeof content === 'string';
  return {
    botId, msgId: body.msgid, reqId: headers.req_id, chatType: body.chattype,
    chatId, senderId, kind: isText ? 'text' : 'unsupported', text: isText ? content : '',
  };
}

export function stableKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function conversationKey(message: WecomMessage): string {
  return stableKey(message.botId, message.chatType, message.chatId);
}
export function isAllowed(message: WecomMessage, policy: { allowedUsers: string[]; allowedChats: string[] }): boolean {
  return policy.allowedUsers.includes(message.senderId)
    && (message.chatType === 'single' || policy.allowedChats.includes(message.chatId));
}

/** Split by code point, never cutting a UTF-8 sequence or silently truncating. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('maxBytes must be at least 4');
  const chunks: string[] = [];
  let chunk = '', size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > maxBytes) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += point; size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
