import { createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { assertPortAvailable, buildCoreEnv, stopChild, waitCoreReady } from '../src/im/wecom/runtime.js';
import { parseWecomConfig } from '../src/im/wecom/config.js';
import { spawnTsEval } from './helpers/ts-runner.js';

describe('WeCom process lifecycle', () => {
  it('scrubs transport credentials and inherited session authority from the core environment', () => {
    const config = parseWecomConfig({ workingDir: '/tmp/project', stateDir: '/tmp/wecom', corePort: 19321, allowedUsers: ['a'] }, '/tmp');
    const env = buildCoreEnv(config, 'local_wecom_test', {
      PATH: '/bin', WECOM_BOT_SECRET: 'private', WECOM_BOT_ID: 'bot', BOTS_CONFIG: '/private/bots.json',
      BOTMUX_SESSION_ID: 'session', BOTMUX_OWNER_OPEN_ID: 'owner', __OWNER_OPEN_ID: 'owner', SESSION_DATA_DIR: '/fleet',
      BOTMUX_CORE_MODEL: 'inherited-model', BOTMUX_CORE_ONLY: '0', LARK_APP_SECRET: 'private-lark',
    });
    expect(env.WECOM_BOT_SECRET).toBeUndefined(); expect(env.WECOM_BOT_ID).toBeUndefined();
    expect(env.BOTS_CONFIG).toBeUndefined(); expect(env.BOTMUX_OWNER_OPEN_ID).toBeUndefined(); expect(env.__OWNER_OPEN_ID).toBeUndefined();
    expect(env.LARK_APP_SECRET).toBeUndefined(); expect(env.BOTMUX_CORE_MODEL).toBeUndefined();
    expect(env.SESSION_DATA_DIR).toBeUndefined(); expect(env.BOTMUX_SESSION_ID).toBeUndefined();
    expect(env.BOTMUX_NO_CLAIM).toBe('1'); expect(env.BOTMUX_API_ONLY_BOT).toBe('local_wecom_test');
    expect(env.BOTMUX_CORE_STATE_DIR).toBe('/tmp/wecom/core');
  });
  it('rejects a port already owned by another local service', async () => {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try { await expect(assertPortAvailable(port)).rejects.toThrow('端口'); }
    finally { await new Promise<void>(r => server.close(() => r())); }
  });
  it('waits for the owned child readiness marker and terminates that child', async () => {
    const child = spawnTsEval("console.log('[core-only] listening on 127.0.0.1:19321 (bot local_wecom_test, cli test)'); setInterval(()=>{},1000)", { stdio: ['ignore', 'pipe', 'pipe'] });
    try { await waitCoreReady(child, 19321, 'local_wecom_test', 2000); }
    finally { await stopChild(child, 300); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it('fails if a child exits before claiming readiness', async () => {
    const child = spawnTsEval('process.exit(2)', { stdio: ['ignore', 'pipe', 'pipe'] });
    await expect(waitCoreReady(child, 19321, 'local_wecom_test', 2000)).rejects.toThrow('启动');
  });
});
