import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntrySpawn } from '../../core/self-spawn.js';
import { withFileLock } from '../../utils/file-lock.js';
import { loadWecomConfig, type WecomConfig } from './config.js';
import { stableKey } from './message.js';
import { WecomStore } from './store.js';
import { WecomBridge, type WecomTransport } from './bridge.js';
import { createCoreClient } from './core-client.js';
import { SdkWecomTransport } from './transport.js';
import { EmployeeTransport } from './employee-transport.js';

interface ManagedTransport extends WecomTransport { start(): Promise<void>; stopReceiving?(): Promise<void>; stop(): void | Promise<void>; closed: Promise<string> }

export function buildCoreEnv(config: WecomConfig, botId: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith('WECOM_') || key.startsWith('BOTMUX_') || key.startsWith('LARK_')
      || ['__OWNER_OPEN_ID', 'SESSION_DATA_DIR', 'BOTS_CONFIG'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    BOTMUX_CORE_ONLY: '1', BOTMUX_NO_CLAIM: '1', BOTMUX_API_PORT: String(config.corePort),
    BOTMUX_API_ONLY_BOT: botId, BOTMUX_CORE_CLI: config.cliId,
    BOTMUX_CORE_WORKING_DIR: config.workingDir, BOTMUX_CORE_STATE_DIR: join(config.stateDir, 'core'),
    BOTMUX_WORKER_HTTP_HOST: '127.0.0.1', WEB_EXTERNAL_HOST: '127.0.0.1',
    ...(config.model ? { BOTMUX_CORE_MODEL: config.model } : {}),
  });
  return env;
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('core-only 端口已占用或无法监听')));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

/** Observe our own child's marker; a successful HTTP response alone could be a foreign service. */
export async function waitCoreReady(child: ChildProcess, port: number, botId: string, timeoutMs = 120000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => fail(), timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.stdout?.off('data', data); child.off('error', fail); child.off('exit', fail); };
    const fail = () => { cleanup(); reject(new Error('core-only 启动失败；请查看专用 core.log')); };
    const data = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop()!.slice(-4096);
      if (lines.some(line => line.startsWith(`[core-only] listening on 127.0.0.1:${port} (bot ${botId},`))) { cleanup(); resolve(); }
    };
    child.stdout?.on('data', data); child.once('error', fail); child.once('exit', fail);
    if (child.exitCode !== null || child.signalCode !== null) fail();
  });
}

export async function stopChild(child: ChildProcess, graceMs = 15000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function runWecom(configPath: string): Promise<void> {
  const { config, credentials, callbackCredentials } = loadWecomConfig(configPath);
  const accountId = config.mode === 'employee' ? `employee:${config.employee!.userId}` : credentials!.botId;
  if (!statSync(config.workingDir).isDirectory()) throw new Error('workingDir 必须是现有目录');
  const lockDir = join(homedir(), '.botmux', 'wecom', 'locks');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const identity = stableKey(accountId).slice(0, 24);
  // Global per-OS-user lock, independent of config/state path; held for the whole connection lifetime.
  await withFileLock(join(lockDir, identity), async () => {
    await assertPortAvailable(config.corePort);
    const coreBotId = `local_wecom_${identity}`;
    const log = (event: string, task?: number) => console.log(`[wecom] ${event}${task === undefined ? '' : ` task=${task}`}`);
    const store = new WecomStore(join(config.stateDir, 'wecom.sqlite'));
    store.bindBot(accountId);
    const logFd = openSync(join(config.stateDir, 'core.log'), 'a', 0o600);
    const spec = resolveEntrySpawn('core-only', fileURLToPath(new URL('../../', import.meta.url)));
    let child: ChildProcess | undefined;
    let transport: ManagedTransport | undefined;
    let bridge: WecomBridge | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let resolveStop!: (reason: string) => void;
    const stopped = new Promise<string>(resolve => { resolveStop = resolve; });
    const signal = () => resolveStop('signal');
    process.on('SIGINT', signal); process.on('SIGTERM', signal);
    try {
      child = spawn(spec.command, spec.args, { cwd: config.workingDir,
        env: buildCoreEnv(config, coreBotId, process.env), stdio: ['ignore', 'pipe', logFd] });
      child.stdout?.on('data', chunk => appendFileSync(logFd, chunk));
      child.once('exit', () => resolveStop('core_exited')); child.once('error', () => resolveStop('core_start_failed'));
      const first = await Promise.race([waitCoreReady(child, config.corePort, coreBotId).then(() => 'ready'), stopped]);
      if (first !== 'ready') { if (first !== 'signal') throw new Error(first); return; }
      transport = config.mode === 'employee'
        ? new EmployeeTransport(config, store, message => bridge!.acceptMessage(message), log, callbackCredentials)
        : new SdkWecomTransport(credentials!, {
        log, onMessage: frame => { void bridge!.accept(frame).catch(() => resolveStop('inbound_storage_failed')); },
      });
      bridge = new WecomBridge({ config, botId: accountId, coreBotId, store,
        core: createCoreClient(config.corePort), transport, log });
      const started = await Promise.race([transport.start().then(() => 'ready'), stopped]);
      if (started !== 'ready') { if (started !== 'signal') throw new Error(started); return; }
      log('ready');
      const tick = () => { void bridge!.tick().catch(() => resolveStop('bridge_storage_failed')); };
      timer = setInterval(tick, config.pollIntervalMs); tick();
      const reason = await Promise.race([stopped, transport.closed]);
      if (reason !== 'signal' && reason !== 'stopped') throw new Error(`企微服务停止：${reason}`);
    } finally {
      if (timer) clearInterval(timer);
      await transport?.stopReceiving?.();
      await bridge?.stop(); await transport?.stop();
      if (child) await stopChild(child);
      process.off('SIGINT', signal); process.off('SIGTERM', signal);
      store.close(); closeSync(logFd); log('stopped');
    }
  }, { maxWaitMs: 250 });
}
