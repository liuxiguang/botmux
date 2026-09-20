import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WecomStore } from '../src/im/wecom/store.js';
import type { WecomMessage } from '../src/im/wecom/message.js';

const dirs: string[] = [], stores: WecomStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function open(path?: string) { const dir = path ?? mkdtempSync(join(tmpdir(), 'wecom-store-')); if (!path) dirs.push(dir); const store = new WecomStore(join(dir, 'db.sqlite')); stores.push(store); return { store, dir }; }
const message = (id: string, senderId = 'alice'): WecomMessage => ({ botId: 'bot-a', msgId: id, reqId: id, chatType: 'group', chatId: 'group-a', senderId, kind: 'text', text: `task ${id}` });

describe('WeCom durable work', () => {
  it('deduplicates callbacks and persists shared conversation mappings', () => {
    const { store, dir } = open();
    const first = store.enqueue(message('one'), 20, 10)!;
    expect(store.enqueue(message('one'), 20, 10)).toBeNull();
    const second = store.enqueue(message('two', 'bob'), 20, 10)!;
    expect(first.conversationKey).toBe(second.conversationKey);
    store.prepareSubmission(first.id, { source: { type: 'webhook' }, target: { kind: 'turn' }, envelope: { format: 'text', sourceName: 'WeCom', trusted: false }, options: { asyncReturnSessionId: true, idempotencyKey: 'fixed' } }, 20);
    store.bind(first.id, 'session-one', 'trigger-one');
    const reopened = open(dir).store;
    expect(reopened.getConversation(first.conversationKey)?.sessionId).toBe('session-one');
    expect(reopened.active()[0]).toMatchObject({ phase: 'running', sessionId: 'session-one', triggerId: 'trigger-one' });
    expect(reopened.ready(100, 5)).toHaveLength(0);
  });
  it('keeps completion independent of delivery and preserves ambiguous sends on restart', () => {
    const { store, dir } = open(); const row = store.enqueue(message('one'), 20, 10)!;
    store.finish(row.id, 'completed', 'answer', ['part one', 'part two']);
    const pending = store.outboxFor(row.id);
    expect(pending).toHaveLength(2);
    store.markSending(pending[0].id);
    const reopened = open(dir).store;
    reopened.recoverSending();
    expect(reopened.outboxFor(row.id).map(o => o.state)).toEqual(['unknown', 'pending']);
    expect(reopened.getMessage(row.id)?.phase).toBe('completed');
  });
  it('rejects reset while work is queued and clears only an idle conversation binding', () => {
    const { store } = open(); const row = store.enqueue(message('one'), 20, 10)!;
    expect(store.reset(row.conversationKey)).toBe(false);
    store.bind(row.id, 'session-one', 'trigger-one');
    store.finish(row.id, 'completed', 'done', []);
    expect(store.reset(row.conversationKey)).toBe(true);
    expect(store.getConversation(row.conversationKey)?.sessionId).toBeNull();
    expect(store.getMessage(row.id)?.sessionId).toBe('session-one');
  });
  it('gives other conversations delivery capacity despite a rate-limited backlog', () => {
    const { store } = open();
    const first = store.enqueue(message('one'), 20, 10)!;
    store.finish(first.id, 'completed', 'long answer', Array.from({ length: 120 }, (_, i) => `part ${i}`));
    const second = store.enqueue({ ...message('two'), chatId: 'group-b' }, 20, 10)!;
    store.finish(second.id, 'completed', 'other answer', ['other answer']);
    for (const out of store.outboxFor(first.id).slice(0, 20)) {
      store.markSending(out.id, 100);
      store.markDelivery(out.id, 'pending');
    }
    expect(store.canSend(first.conversationKey, 100)).toBe(false);
    expect(store.pendingOutbox(100).map(o => o.conversationKey)).toEqual([second.conversationKey]);
    expect(store.pendingOutbox(60101).map(o => o.conversationKey)).toEqual([first.conversationKey, second.conversationKey]);
  });
});
