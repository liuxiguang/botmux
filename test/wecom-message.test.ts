import { describe, expect, it } from 'vitest';
import { conversationKey, isAllowed, normalizeMessage, splitUtf8 } from '../src/im/wecom/message.js';

const frame = (user = 'alice', group = 'group-a', bot = 'bot-a') => ({
  headers: { req_id: 'request-a' }, body: { aibotid: bot, msgid: 'message-a', chattype: 'group', chatid: group, from: { userid: user }, msgtype: 'text', text: { content: 'hello' } },
});
describe('WeCom messages', () => {
  it('shares a group across senders while isolating bots and other groups', () => {
    const key = (f: unknown, bot = 'bot-a') => conversationKey(normalizeMessage(f, bot)!);
    expect(key(frame('alice'))).toBe(key(frame('bob')));
    expect(key(frame('alice'))).not.toBe(key(frame('alice', 'group-b')));
    expect(key(frame('alice'))).not.toBe(key(frame('alice', 'group-a', 'bot-b'), 'bot-b'));
  });
  it('routes a single conversation to its authenticated sender, ignoring an extraneous chat id', () => {
    const f = frame(); f.body.chattype = 'single';
    expect(normalizeMessage(f, 'bot-a')).toMatchObject({ chatType: 'single', chatId: 'alice', senderId: 'alice', text: 'hello' });
  });
  it('rejects malformed callbacks and a mismatched bot identity', () => {
    expect(normalizeMessage(frame(), 'wrong-bot')).toBeNull();
    expect(normalizeMessage({ headers: {}, body: frame().body }, 'bot-a')).toBeNull();
    const f = frame(); f.body.chatid = '';
    expect(normalizeMessage(f, 'bot-a')).toBeNull();
    expect(normalizeMessage(null, 'bot-a')).toBeNull();
  });
  it('requires both sender and group allowlists', () => {
    const message = normalizeMessage(frame(), 'bot-a')!;
    expect(isAllowed(message, { allowedUsers: ['alice'], allowedChats: ['group-a'] })).toBe(true);
    expect(isAllowed(message, { allowedUsers: ['bob'], allowedChats: ['group-a'] })).toBe(false);
    expect(isAllowed(message, { allowedUsers: ['alice'], allowedChats: [] })).toBe(false);
  });
  it('preserves unsupported message routing without treating it as a prompt', () => {
    const f = frame(); f.body.msgtype = 'image';
    expect(normalizeMessage(f, 'bot-a')).toMatchObject({ kind: 'unsupported', text: '' });
  });
  it('splits by UTF-8 bytes without losing multilingual text or emoji', () => {
    const text = '中文🙂abc\n'.repeat(40);
    const parts = splitUtf8(text, 17);
    expect(parts.join('')).toBe(text);
    expect(parts.every(p => Buffer.byteLength(p) <= 17)).toBe(true);
    expect(() => splitUtf8('🙂', 3)).toThrow();
  });
});
