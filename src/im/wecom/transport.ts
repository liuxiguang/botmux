import { WSClient, type WSClientOptions } from '@wecom/aibot-node-sdk';
import { ProxyAgent } from 'proxy-agent';
import type { WecomCredentials } from './config.js';
import { stableKey, type WecomMessage } from './message.js';
import { DeliveryError, type WecomTransport } from './bridge.js';

interface TransportOptions {
  onMessage?: (frame: unknown) => void;
  log?: (event: string) => void;
  /** Injectable transport endpoint for local protocol tests; not a user config field. */
  wsUrl?: string;
  authTimeoutMs?: number;
}

export class SdkWecomTransport implements WecomTransport {
  private client: WSClient;
  private ready = false;
  private stopped = false;
  private resolveClosed!: (reason: string) => void;
  readonly closed = new Promise<string>(resolve => { this.resolveClosed = resolve; });
  constructor(credentials: WecomCredentials, private options: TransportOptions = {}) {
    // SDK diagnostics may include raw frames and credential-bearing payloads.
    // Expose only our fixed lifecycle events, never SDK strings or objects.
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const sdkOptions: WSClientOptions = {
      ...credentials, logger, maxAuthFailureAttempts: 1, maxReconnectAttempts: 10,
      maxReplyQueueSize: 20, ...(options.wsUrl ? { wsUrl: options.wsUrl } : {}),
      wsOptions: { handshakeTimeout: 15000, ...(options.wsUrl ? {} : { agent: new ProxyAgent() }) },
    };
    this.client = new WSClient(sdkOptions);
    this.client.on('authenticated', () => { this.ready = true; options.log?.('authenticated'); });
    this.client.on('message', frame => { if (this.ready && !this.stopped) options.onMessage?.(frame); });
    this.client.on('disconnected', () => { this.ready = false; options.log?.('disconnected'); });
    this.client.on('reconnecting', () => options.log?.('reconnecting'));
    this.client.on('event.disconnected_event', () => { this.resolveClosed('connection_replaced'); this.stop(); });
    this.client.on('error', error => {
      options.log?.('transport_error');
      const code = (error as Error & { code?: string }).code;
      if (code === 'WS_AUTH_FAILURE_EXHAUSTED' || code === 'WS_RECONNECT_EXHAUSTED') {
        this.resolveClosed(code === 'WS_AUTH_FAILURE_EXHAUSTED' ? 'authentication_failed' : 'reconnect_exhausted'); this.stop();
      }
    });
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error('企微连接已停止');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); this.stop(); reject(new Error('企业微信认证超时')); }, this.options.authTimeoutMs ?? 30000);
      const success = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timeout); this.client.off('authenticated', success); };
      this.client.once('authenticated', success);
      this.closed.then(() => { cleanup(); reject(new Error('企业微信认证或连接失败')); });
      this.client.connect();
    });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.ready = false;
    this.client.disconnect(); this.resolveClosed('stopped');
  }
  private async deliver(send: () => Promise<unknown>): Promise<void> {
    if (!this.ready || this.stopped) throw new DeliveryError('retryable');
    try { await send(); }
    catch (error) {
      const code = error !== null && typeof error === 'object' ? (error as { errcode?: unknown }).errcode : undefined;
      // SDK rejects the actual ACK frame on a negative response; ordinary Error
      // (timeout/disconnect) gives no evidence that the platform rejected delivery.
      if (typeof code === 'number' && code !== 0) throw new DeliveryError(code === -1 || code === 45009 ? 'retryable' : 'rejected');
      throw new DeliveryError('unknown');
    }
  }
  reply(message: WecomMessage, content: string): Promise<void> {
    return this.deliver(() => this.client.replyStream({ headers: { req_id: message.reqId } },
      stableKey(message.botId, message.msgId, 'ack').slice(0, 32), content, true));
  }
  send(message: WecomMessage, content: string): Promise<void> {
    return this.deliver(() => this.client.sendMessage(message.chatId, { msgtype: 'markdown', markdown: { content } }));
  }
}
