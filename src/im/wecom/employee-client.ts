import { execFile } from 'node:child_process';
import type { EmployeeConfig } from './config.js';
import type { EmployeeApi, MessagePage, MessageQuery } from './employee-inbox.js';

export class CliFailure extends Error {
  constructor(readonly outcome: 'retryable' | 'rejected' | 'unknown', readonly code?: number) {
    super(`企微 CLI 调用失败（${outcome}${code === undefined ? '' : `，code=${code}`}）`);
  }
}
export function parseCliResult(stdout: string, failed: boolean): Record<string, unknown> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch { throw new CliFailure('unknown'); }
  const error = data.error as { code?: unknown } | undefined;
  const code = typeof data.errcode === 'number' ? data.errcode : typeof error?.code === 'number' ? error.code : undefined;
  if (code !== undefined && code !== 0) throw new CliFailure(code === 45009 || code === -1 || code === 429 ? 'retryable' : 'rejected', code);
  if (failed || error) throw new CliFailure('unknown');
  return data;
}
export function parseMessagePage(data: Record<string, unknown>): MessagePage {
  // Live CLI 1.3 omits messages entirely for an explicitly empty result.
  if (data.messages === undefined && data.messages_count === 0 && data.has_more === false) return { messages: [], has_more: false };
  if (!Array.isArray(data.messages) || typeof data.has_more !== 'boolean') throw new CliFailure('unknown');
  return data as unknown as MessagePage;
}
export function parseEmployeeIdentity(data: Record<string, unknown>): { userId: string; name: string } {
  const context = data.extra_identity_context;
  // Currently the official schema supplies a textual identity context, not separate fields.
  // Fail closed if that contract changes; never select the first (bot) ID in the string.
  const match = typeof context === 'string' && context.match(/授权真人用户身份[：:]\s*\r?\n名字[：:]\s*([^\r\n]+)\r?\nID[：:]\s*([^\s<>]+)/);
  if (!match || match[2].length > 256) throw new Error('无法确认企微 CLI 授权员工身份');
  return { userId: match[2], name: match[1].trim() };
}
export function employeeCliEnv(inherited: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, ...(configDir ? { WECOM_CLI_CONFIG_DIR: configDir } : {}) };
  // Empty LOG_DIR enables logging in cwd; remove the key entirely to disable file logging.
  delete env.WECOM_CLI_LOG_DIR; delete env.WECOM_CLI_LOG_LEVEL;
  return env;
}

/** One queue for discovery-facing CLI calls, reads and sends; never invoke a shell. */
export class EmployeeClient implements EmployeeApi {
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private stopped = false;
  private abort = new AbortController();
  constructor(private config: EmployeeConfig) {}
  stop(): void { this.stopped = true; this.abort.abort(); }
  private call(args: string[], body?: unknown): Promise<Record<string, unknown>> {
    const operation = this.queue.then(async () => {
      if (this.stopped) throw new CliFailure('retryable');
      const delay = Math.max(0, this.nextAt - Date.now());
      if (delay) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, delay); this.abort.signal.addEventListener('abort', done, { once: true });
      });
      if (this.stopped) throw new CliFailure('retryable');
      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          execFile(this.config.cliPath, [...args, ...(body === undefined ? [] : ['--json', JSON.stringify(body)])], {
            timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: this.abort.signal,
            env: employeeCliEnv(process.env, this.config.cliConfigDir),
          }, (error, stdout) => { try { resolve(parseCliResult(stdout, Boolean(error))); } catch (e) { reject(e); } });
        });
      } catch (error) {
        if (error instanceof CliFailure && error.outcome === 'retryable') this.nextAt = Date.now() + 60000;
        throw error;
      } finally { this.nextAt = Math.max(this.nextAt, Date.now() + this.config.requestIntervalMs); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async identity(): Promise<{ userId: string; name: string }> {
    const identity = parseEmployeeIdentity(await this.call(['identity', 'whoami']));
    if (identity.userId !== this.config.userId) throw new Error('企微 CLI 授权员工身份与配置不一致');
    return identity;
  }
  async read(query: MessageQuery): Promise<MessagePage> {
    const data = await this.call(['chat', 'messages', 'list'], query);
    return parseMessagePage(data);
  }
  async send(chatId: string, content: string): Promise<void> {
    // The platform currently exposes no sender selector. Refuse to send after account changes.
    try { await this.identity(); }
    catch (error) {
      // No send has started: uncertain identity-query outcomes are safe to retry.
      throw new CliFailure(error instanceof CliFailure && error.outcome !== 'rejected' ? 'retryable' : 'rejected');
    }
    if (Buffer.byteLength(content, 'utf8') > 2048) throw new CliFailure('rejected');
    await this.call(['message', 'send'], { chat_id: chatId, msg_type: 'text', text: { content } });
  }
}
