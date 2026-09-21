import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWecomConfig, parseWecomConfig } from '../src/im/wecom/config.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const raw = { workingDir: './repo', stateDir: './state', corePort: 19321, allowedUsers: ['user-a'], adminUsers: ['user-a'], allowedChats: ['group-a'] };

describe('WeCom configuration boundary', () => {
  it('resolves paths against config directory and defaults to a shared group session', () => {
    const c = parseWecomConfig(raw, '/config');
    expect(c.workingDir).toBe('/config/repo');
    expect(c.stateDir).toBe('/config/state');
    expect(c.cliId).toBe('codex-app');
  });
  it('rejects misspelled fields, invalid limits, and administrators without access', () => {
    for (const patch of [{ allowedUser: ['x'] }, { maxConcurrent: 0 }, { corePort: 0 }, { adminUsers: ['other'] }, { allowedUsers: [] }]) {
      expect(() => parseWecomConfig({ ...raw, ...patch }, '/config')).toThrow();
    }
  });
  it('accepts employee mode without bot secrets and rejects unapproved conversations', () => {
    const employee = { userId: 'user-a', chats: [{ chatId: 'group-a', chatType: 'group' }] };
    const c = parseWecomConfig({ ...raw, mode: 'employee', employee }, '/config');
    expect(c.mode).toBe('employee');
    expect(c.employee?.chats[0].chatId).toBe('group-a');
    expect(() => parseWecomConfig({ ...raw, mode: 'employee' }, '/config')).toThrow();
    expect(() => parseWecomConfig({ ...raw, mode: 'employee', employee: { ...employee, chats: [{ chatId: 'unapproved', chatType: 'group' }] } }, '/config')).toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'wecom-config-')); dirs.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, mode: 'employee', employee }));
    expect(loadWecomConfig(join(dir, 'config.json'), {}).credentials).toBeNull();
  });
  it('loads a named env file without mutating process.env and gives explicit env precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-config-')); dirs.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, envFile: './private.env' }));
    writeFileSync(join(dir, 'private.env'), 'WECOM_BOT_ID=bot-file\nWECOM_BOT_SECRET=secret-file\n');
    const loaded = loadWecomConfig(join(dir, 'config.json'), { WECOM_BOT_ID: 'bot-env' });
    expect(loaded.credentials).toEqual({ botId: 'bot-env', secret: 'secret-file' });
    expect(process.env.WECOM_BOT_SECRET).not.toBe('secret-file');
  });
  it('reports missing field names without including supplied credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-config-')); dirs.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
    let message = '';
    try { loadWecomConfig(join(dir, 'config.json'), { WECOM_BOT_SECRET: 'private-secret' }); } catch (e) { message = String(e); }
    expect(message).toContain('WECOM_BOT_ID');
    expect(message).not.toContain('private-secret');
  });
});
