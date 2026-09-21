import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WecomStore } from '../src/im/wecom/store.js';
import { WecomBridge } from '../src/im/wecom/bridge.js';
import { parseWecomConfig } from '../src/im/wecom/config.js';
import type { TriggerRequest, TriggerResponse } from '../src/services/trigger-types.js';

const dirs: string[] = [], stores: WecomStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const frame = (id: string, user = 'alice', text = 'hello', group = 'group-a') => ({ headers: { req_id: id }, body: { aibotid: 'bot-a', msgid: id, chattype: 'group', chatid: group, from: { userid: user }, msgtype: 'text', text: { content: text } } });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-bridge-')); dirs.push(dir);
  const store = new WecomStore(join(dir, 'db.sqlite')); stores.push(store);
  const config = parseWecomConfig({ workingDir: dir, stateDir: dir, corePort: 19321, allowedUsers: ['alice', 'bob'], allowedChats: ['group-a', 'group-b'], adminUsers: ['alice'] }, dir);
  const submitted: TriggerRequest[] = [], polled: string[][] = [];
  let result: TriggerResponse = { ok: true, state: 'running' }, loseResponse = false;
  const core = {
    async submit(req: TriggerRequest): Promise<TriggerResponse> { submitted.push(req); if (loseResponse) { loseResponse = false; throw new Error('lost response'); } return { ok: true, triggerId: `t${submitted.length}`, target: { kind: 'turn', sessionId: 'session-one' } }; },
    async result(session: string, trigger: string) { polled.push([session, trigger]); return result; },
  };
  const sent: string[] = [];
  const transport = { async reply(_msg: unknown, text: string) { sent.push(text); }, async send(_msg: unknown, text: string) { sent.push(text); } };
  let now = 100000;
  const bridge = new WecomBridge({ config, botId: 'bot-a', coreBotId: 'local_wecom_test', store, core, transport, now: () => now });
  return { bridge, store, submitted, polled, sent, core, transport, config, setResult: (r: TriggerResponse) => { result = r; }, lose: () => { loseResponse = true; }, advance: () => { now += 60000; } };
}

describe('WeCom execution bridge', () => {
  it('accepts normalized employee events and respects the text transport byte limit', async () => {
    const f = setup();
    const transport = { ...f.transport, maxMessageBytes: 2048 };
    const employeeStore = new WecomStore(join(dirs[0], 'employee.sqlite')); stores.push(employeeStore);
    const bridge = new WecomBridge({ config: f.config, botId: 'employee:owner', coreBotId: 'local_employee', store: employeeStore, core: f.core, transport });
    await bridge.acceptMessage({ botId: 'employee:owner', msgId: 'm1', reqId: 'm1', chatType: 'single', chatId: 'alice', senderId: 'alice', kind: 'text', text: 'task' });
    await bridge.tick(); f.setResult({ ok: true, state: 'completed', output: { content: '中'.repeat(5000) } }); await bridge.tick();
    const parts = employeeStore.outboxFor(1).filter(o => o.kind === 'send');
    expect(parts.length).toBeGreaterThan(1); expect(parts.every(o => Buffer.byteLength(o.content) <= 2048)).toBe(true);
  });
  it('serializes two senders in a shared group and polls exact turns', async () => {
    const f = setup();
    await f.bridge.accept(frame('one')); await f.bridge.accept(frame('two', 'bob'));
    await f.bridge.tick(); await f.bridge.tick();
    expect(f.submitted).toHaveLength(1);
    f.setResult({ ok: true, state: 'completed', output: { content: 'first answer' } }); f.advance();
    await f.bridge.tick();
    expect(f.submitted).toHaveLength(2);
    expect(f.submitted[1].target.sessionId).toBe('session-one');
    expect(f.submitted[1].options?.turnIdempotencyKey).toBeTruthy();
    expect(f.submitted[1].options?.idempotencyKey).toBeUndefined();
    expect(f.polled).toContainEqual(['session-one', 't1']);
    expect(f.store.getMessage(1)?.result).toBe('first answer');
  });
  it('reuses the immutable submission and idempotency key after a lost response', async () => {
    const f = setup(); f.lose(); await f.bridge.accept(frame('one')); await f.bridge.tick();
    const first = structuredClone(f.submitted[0]);
    f.advance(); await f.bridge.tick();
    expect(f.submitted).toHaveLength(2); expect(f.submitted[1]).toEqual(first);
    await f.bridge.accept(frame('one')); await f.bridge.tick(); expect(f.submitted).toHaveLength(2);
  });
  it('refuses unauthorized users and does not execute protocol commands as prompts', async () => {
    const f = setup();
    await f.bridge.accept(frame('no', 'mallory'));
    await f.bridge.accept(frame('new', 'bob', '/new'));
    await f.bridge.accept(frame('status', 'alice', '/status'));
    await f.bridge.tick();
    expect(f.submitted).toHaveLength(0);
    expect(f.store.getMessage(1)?.phase).toBe('command');
    expect(f.store.getMessage(1)?.result).toContain('管理员');
  });
  it('does not silently create another session after not_found and rejects queued work', async () => {
    const f = setup(); await f.bridge.accept(frame('one')); await f.bridge.accept(frame('two')); await f.bridge.tick();
    f.setResult({ ok: true, state: 'not_found' }); f.advance(); await f.bridge.tick();
    expect(f.submitted).toHaveLength(1);
    expect(f.store.getMessage(1)?.phase).toBe('failed');
    expect(f.store.getMessage(2)?.phase).toBe('failed');
    await f.bridge.accept(frame('reset', 'alice', '/new'));
    await f.bridge.accept(frame('three')); f.advance(); await f.bridge.tick();
    expect(f.submitted).toHaveLength(2);
    expect(f.submitted[1].target.sessionId).toBeUndefined();
  });
  it('recognizes commands after the configured group mention without executing them as prompts', async () => {
    const f = setup(); f.config.botName = 'Coco bot';
    await f.bridge.accept(frame('one', 'alice', '@Coco bot /status'));
    await f.bridge.tick();
    expect(f.submitted).toHaveLength(0);
    expect(f.store.getMessage(1)?.phase).toBe('command');
  });
  it('keeps an unacknowledged result distinct from completion and does not resend it', async () => {
    const f = setup(); await f.bridge.accept(frame('one')); await f.bridge.tick();
    f.transport.send = async () => { throw new Error('connection closed after send'); };
    f.setResult({ ok: true, state: 'completed', output: { content: 'completed output' } }); f.advance(); await f.bridge.tick();
    expect(f.store.getMessage(1)?.phase).toBe('completed');
    expect(f.store.outboxFor(1).find(o => o.kind === 'send')?.state).toBe('unknown');
    const attempts = f.store.outboxFor(1).find(o => o.kind === 'send')?.attempts;
    f.advance(); await f.bridge.tick();
    expect(f.store.outboxFor(1).find(o => o.kind === 'send')?.attempts).toBe(attempts);
  });
});
