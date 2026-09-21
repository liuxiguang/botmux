import type { CallbackCredentials, WecomConfig } from './config.js';
import type { WecomStore } from './store.js';
import type { WecomMessage } from './message.js';
import { DeliveryError, type WecomTransport } from './bridge.js';
import { EmployeeClient, CliFailure } from './employee-client.js';
import { EmployeeInbox } from './employee-inbox.js';
import { EmployeeCallback } from './employee-callback.js';

export class EmployeeTransport implements WecomTransport {
  readonly maxMessageBytes = 2048;
  private client: EmployeeClient;
  private inbox: EmployeeInbox;
  private callback?: EmployeeCallback;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private requested = false;
  private stopped = false;
  private receivingStopped = false;
  private nextAt = 0;
  private failures = 0;
  private resolveClosed!: (reason: string) => void;
  readonly closed = new Promise<string>(resolve => { this.resolveClosed = resolve; });
  constructor(private config: WecomConfig, store: WecomStore, onMessage: (message: WecomMessage) => Promise<void>,
    private log: (event: string) => void, callbackCredentials?: CallbackCredentials) {
    this.client = new EmployeeClient(config.employee!);
    this.inbox = new EmployeeInbox(config, store, this.client, onMessage);
    if (config.employee!.callback) {
      if (!callbackCredentials) throw new Error('缺少员工回调凭证');
      this.callback = new EmployeeCallback(config.employee!.callback, callbackCredentials, () => {
        this.log('employee_callback_received'); this.requested = true; this.wake();
      });
    }
  }
  async start(): Promise<void> {
    await this.inbox.initialize();
    this.log('employee_identity_verified');
    if (this.callback) { await this.callback.start(); this.log('employee_callback_listening'); }
    else this.log('employee_polling_only');
    this.timer = setInterval(() => this.wake(), 1000); this.wake();
  }
  private wake(): void {
    if (this.receivingStopped || this.stopped || this.running) return;
    // Notifications may bypass the normal interval, but never the failure backoff.
    if (Date.now() < this.nextAt && (!this.requested || this.failures > 0)) return;
    this.requested = false;
    this.running = this.inbox.poll().then(() => {
      this.failures = 0; this.nextAt = Date.now() + this.config.employee!.pollIntervalMs;
      this.log('employee_poll_complete');
    }).catch(error => {
      this.failures++;
      this.nextAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(this.failures - 1, 4));
      this.log('employee_poll_failed');
      if (error instanceof Error && (error.message.includes('身份') || error.message.includes('历史缺口'))) {
        this.resolveClosed(error.message.includes('身份') ? 'employee_identity_changed' : 'employee_history_gap');
      }
    }).finally(() => { this.running = undefined; if (this.requested && !this.failures) this.wake(); });
  }
  async stopReceiving(): Promise<void> {
    this.receivingStopped = true; this.inbox.stop();
    if (this.timer) clearInterval(this.timer);
    await this.callback?.stop(); await this.running;
  }
  async stop(): Promise<void> {
    await this.stopReceiving(); this.stopped = true;
    this.client.stop(); this.resolveClosed('stopped');
  }
  reply(message: WecomMessage, content: string): Promise<void> { return this.send(message, content); }
  async send(message: WecomMessage, content: string): Promise<void> {
    if (this.stopped || message.botId !== this.inbox.accountId || !this.config.employee!.chats.some(c => c.chatId === message.chatId && c.chatType === message.chatType)) throw new DeliveryError('rejected');
    try { await this.client.send(message.chatId, content); }
    catch (error) { throw new DeliveryError(error instanceof CliFailure ? error.outcome : 'unknown'); }
  }
}
