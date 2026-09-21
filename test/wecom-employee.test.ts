import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWecomConfig } from '../src/im/wecom/config.js';
import { WecomStore } from '../src/im/wecom/store.js';
import { EmployeeInbox, type EmployeeApi } from '../src/im/wecom/employee-inbox.js';
import { parseEmployeeIdentity, parseCliResult, CliFailure, EmployeeClient, employeeCliEnv, parseMessagePage } from '../src/im/wecom/employee-client.js';

const dirs: string[] = [], stores: WecomStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const baseTime = Date.parse('2026-09-21T11:00:00+08:00');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-employee-')); dirs.push(dir);
  const store = new WecomStore(join(dir, 'state.sqlite')); stores.push(store);
  const config = parseWecomConfig({ mode: 'employee', workingDir: dir, stateDir: dir, corePort: 19322,
    allowedUsers: ['owner', 'peer'], allowedChats: ['group'], employee: { userId: 'owner', chats: [{ chatId: 'peer', chatType: 'single' }, { chatId: 'group', chatType: 'group' }] } }, dir);
  let now = baseTime, fail = false, mismatch = false;
  let rows: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const api: EmployeeApi = { identity: async () => ({ userId: mismatch ? 'wrong' : 'owner', name: 'Employee' }),
    read: async (query) => { requests.push(query); if (fail) throw new Error('unavailable'); return { messages: rows, has_more: false }; } };
  const inbox = () => new EmployeeInbox(config, store, api, async m => { store.enqueue(m, 20, now); }, () => now);
  return { config, store, requests, inbox, advance: (ms = 30000) => { now += ms; }, setRows: (r: Record<string, unknown>[]) => { rows = r; }, fail: () => { fail = true; }, mismatch: () => { mismatch = true; } };
}
const msg = (sender: string, text: string, time = '2026-09-21 11:00:10') => ({ userid: sender, user_name: 'Sender', send_time: time, msg_type: 'text', text: { content: text } });

describe('employee CLI boundary', () => {
  it('accepts the live CLI empty-page shape without hiding malformed responses', () => {
    expect(parseMessagePage({ messages_count: 0, has_more: false })).toEqual({ messages: [], has_more: false });
    expect(() => parseMessagePage({ has_more: false })).toThrow(CliFailure);
    expect(() => parseMessagePage({ messages_count: 1, has_more: false })).toThrow(CliFailure);
  });
  it('retries transient identity failures before sending, but rejects account mismatches', async () => {
    const f = fixture(), client = new EmployeeClient(f.config.employee!);
    const identity = vi.spyOn(client, 'identity');
    for (const outcome of ['retryable', 'unknown'] as const) {
      identity.mockRejectedValueOnce(new CliFailure(outcome));
      await expect(client.send('group', 'answer')).rejects.toMatchObject({ outcome: 'retryable' });
    }
    identity.mockRejectedValueOnce(new Error('身份不一致'));
    await expect(client.send('group', 'answer')).rejects.toMatchObject({ outcome: 'rejected' });
    client.stop();
  });
  it('removes CLI log paths instead of turning an empty path into working-directory logs', () => {
    const env = employeeCliEnv({ WECOM_CLI_LOG_DIR: '/private/logs', WECOM_CLI_LOG_LEVEL: 'trace', PATH: '/bin' }, '/private/credentials');
    expect(env).not.toHaveProperty('WECOM_CLI_LOG_DIR'); expect(env).not.toHaveProperty('WECOM_CLI_LOG_LEVEL');
    expect(env.WECOM_CLI_CONFIG_DIR).toBe('/private/credentials'); expect(env.PATH).toBe('/bin');
  });
  it('extracts the authorized human rather than the bot and refuses ambiguous identity', () => {
    const identity = { extra_identity_context: '机器人身份：\n名字：Bot\nID：bot-id\n授权真人用户身份：\n名字：Employee\nID：employee-id\n其他说明' };
    expect(parseEmployeeIdentity(identity)).toEqual({ userId: 'employee-id', name: 'Employee' });
    expect(() => parseEmployeeIdentity({ extra_identity_context: '机器人身份：\nID：bot-id' })).toThrow();
  });
  it('does not confuse a business error, invalid JSON or uncertain transport with success', () => {
    expect(parseCliResult('{}', false)).toEqual({});
    expect(() => parseCliResult('{"errcode":853006,"errmsg":"private detail"}', false)).toThrow(CliFailure);
    expect(() => parseCliResult('{"error":{"code":45009,"message":"private detail"}}', true)).toThrow(CliFailure);
    expect(() => parseCliResult('private non-json output', true)).toThrow(CliFailure);
    try { parseCliResult('{"errcode":853006,"errmsg":"private detail"}', false); } catch (e) { expect(String(e)).not.toContain('private detail'); }
  });
});

describe('employee inbox', () => {
  it('continues healthy chats when another chat cannot be read', async () => {
    const f = fixture(); const read = vi.fn(async (q: { chat_id: string }) => {
      if (q.chat_id === 'peer') throw new CliFailure('rejected', 60011);
      return { messages: [msg('peer', '/codex healthy')], has_more: false };
    });
    const api = { identity: async () => ({ userId: 'owner', name: 'Employee' }), read };
    let now = baseTime;
    const inbox = new EmployeeInbox(f.config, f.store, api, async m => { f.store.enqueue(m, 20, now); }, () => now);
    await inbox.initialize(); now += 30000;
    await expect(inbox.poll()).rejects.toThrow();
    expect(f.store.getMessage(1)?.message.text).toBe('healthy');
    expect(f.store.getCheckpoint('employee:single:peer')).toBe(String(baseTime));
    expect(f.store.getCheckpoint('employee:group:group')).toBe(String(now - 1000));
  });
  it('does not accept or advance a chat when stopped during an outstanding read', async () => {
    const f = fixture(); let finish!: (value: { messages: Record<string, unknown>[]; has_more: boolean }) => void;
    let started!: () => void; const reading = new Promise<void>(r => { started = r; });
    const api: EmployeeApi = { identity: async () => ({ userId: 'owner', name: 'Employee' }),
      read: () => { started(); return new Promise(r => { finish = r; }); } };
    let now = baseTime;
    const inbox = new EmployeeInbox(f.config, f.store, api, async m => { f.store.enqueue(m, 20, now); }, () => now);
    await inbox.initialize(); now += 30000;
    const polling = inbox.poll(); await reading; inbox.stop();
    finish({ messages: [msg('peer', 'pending')], has_more: false }); await polling;
    expect(f.store.getMessage(1)).toBeNull();
    expect(f.store.getCheckpoint('employee:single:peer')).toBe(String(baseTime));
  });
  it('skips old history, own replies, unauthorized senders, and unaddressed group chatter', async () => {
    const f = fixture(), inbox = f.inbox(); await inbox.initialize(); f.advance();
    f.setRows([msg('peer', 'old', '2026-09-21 10:59:59'), msg('owner', 'my reply'), msg('outsider', 'bad'), msg('peer', 'hello')]);
    await inbox.poll();
    expect(f.store.getMessage(1)?.message.text).toBe('hello');
    expect(f.store.getMessage(1)?.message.chatType).toBe('single');
    expect(f.store.getMessage(2)).toBeNull();
  });
  it('preserves identical same-second messages and deduplicates overlap after restart', async () => {
    const f = fixture(), inbox = f.inbox(); await inbox.initialize(); f.advance();
    f.setRows([msg('peer', 'repeat'), msg('peer', 'repeat')]); await inbox.poll();
    expect(f.store.getMessage(1)?.message.text).toBe('repeat'); expect(f.store.getMessage(2)?.message.text).toBe('repeat');
    f.advance(); const restarted = f.inbox(); await restarted.initialize(); await restarted.poll();
    expect(f.store.getMessage(3)).toBeNull();
  });
  it('only accepts own explicit commands and strips the trigger prefix before execution', async () => {
    const f = fixture(), inbox = f.inbox(); await inbox.initialize(); f.advance();
    f.setRows([msg('owner', '/codex calculate 17*19')]); await inbox.poll();
    expect(f.store.getMessage(1)?.message.text).toBe('calculate 17*19');
  });
  it('refuses an account switch and preserves the watermarks on failed reads', async () => {
    const f = fixture(), inbox = f.inbox(); await inbox.initialize(); f.advance(); f.fail();
    await expect(inbox.poll()).rejects.toThrow();
    expect(f.store.getCheckpoint('employee:single:peer')).toBe(String(baseTime));
    const switched = fixture(); switched.mismatch(); await expect(switched.inbox().initialize()).rejects.toThrow('身份');
  });
  it('reads every page before chronological delivery, and rejects missing pagination cursors', async () => {
    const f = fixture(); let broken = false;
    const api: EmployeeApi = { identity: async () => ({ userId: 'owner', name: 'Employee' }),
      read: async q => q.cursor ? { messages: [msg('peer', 'first')], has_more: false }
        : { messages: [msg('peer', 'second', '2026-09-21 11:00:20')], has_more: true, ...(broken ? {} : { next_cursor: 'older' }) } };
    const inbox = new EmployeeInbox(f.config, f.store, api, async m => { f.store.enqueue(m, 20, baseTime); }, () => baseTime + 30000);
    // Independent persisted start: a restarted instance must collect the pending window.
    f.store.setCheckpoint('employee:single:peer', String(baseTime)); f.store.setCheckpoint('employee:group:group', String(baseTime));
    await inbox.initialize(); await inbox.poll();
    expect(f.store.getMessage(1)?.message.text).toBe('first'); expect(f.store.getMessage(2)?.message.text).toBe('second');
    broken = true; await expect(inbox.poll()).rejects.toThrow('分页');
  });
});
