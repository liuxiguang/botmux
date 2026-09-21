import type { WecomConfig } from './config.js';
import { conversationKey, isAllowed, normalizeMessage, splitUtf8, stableKey, type WecomMessage } from './message.js';
import { WecomStore, type WorkItem } from './store.js';
import { CoreRequestError, type CoreClient } from './core-client.js';
import type { TriggerRequest } from '../../services/trigger-types.js';

export interface WecomTransport {
  maxMessageBytes?: number;
  reply(message: WecomMessage, content: string): Promise<void>;
  send(message: WecomMessage, content: string): Promise<void>;
}
/** Only a transport with a definite negative ACK may request a retry. */
export class DeliveryError extends Error {
  constructor(readonly outcome: 'retryable' | 'rejected' | 'unknown') { super(`企微投递状态：${outcome}`); }
}
export interface BridgeOptions {
  config: WecomConfig; botId: string; coreBotId: string; store: WecomStore;
  core: CoreClient; transport: WecomTransport; now?: () => number;
  log?: (event: string, task?: number) => void;
}

export class WecomBridge {
  private now: () => number;
  private stopping = false;
  private ticking: Promise<void> | null = null;
  constructor(private options: BridgeOptions) {
    this.now = options.now ?? Date.now;
    options.store.bindBot(options.botId);
    options.store.recoverSending();
  }
  private log(event: string, task?: number): void { this.options.log?.(event, task); }

  async accept(frame: unknown): Promise<void> {
    const message = normalizeMessage(frame, this.options.botId);
    if (!message) { this.log('inbound_rejected'); return; }
    await this.acceptMessage(message);
  }

  async acceptMessage(message: WecomMessage): Promise<void> {
    if (this.stopping) return;
    const { botId, config, store } = this.options;
    if (message.botId !== botId || !isAllowed(message, config)) { this.log('inbound_rejected'); return; }
    let text = message.text.trim();
    if (message.chatType === 'group' && config.botName) {
      const mention = `@${config.botName}`;
      if (text.startsWith(mention) && /^\s/.test(text.slice(mention.length))) text = text.slice(mention.length).trim();
    }
    const isCommand = text.startsWith('/') || message.kind !== 'text' || !text || Buffer.byteLength(text) > config.maxInputBytes;
    const row = store.enqueue(message, config.maxQueuedPerChat, this.now(), isCommand);
    if (!row) { this.log('duplicate'); return; }
    this.log('received', row.id);
    let notice = row.result;
    if (!notice && isCommand) {
      if (message.kind !== 'text') notice = '目前支持文字任务，请发送文本。';
      else if (!text) notice = '请输入文字任务。';
      else if (Buffer.byteLength(text) > config.maxInputBytes) notice = '消息过长，请拆分后发送。';
      else if (text === '/help') notice = '直接发送文字运行任务。群成员共享上下文，任务按顺序执行。\n/status 查看执行与投递状态；/new 管理员在空闲时开启新会话。';
      else if (text === '/new') {
        notice = !config.adminUsers.includes(message.senderId) ? '只有管理员可以开启新会话。'
          : store.reset(row.conversationKey) ? '已开启新会话，下一条任务将使用新的上下文。' : '仍有运行或排队任务，暂时不能开启新会话。';
      } else if (text === '/status') {
        const latest = store.latest(row.conversationKey, row.id);
        const delivery = latest ? store.outboxFor(latest.id).filter(o => o.kind === 'send') : [];
        const phases: Record<string, string> = { queued: '排队中', submitting: '正在提交', running: '执行中', completed: '执行完成', failed: '执行失败' };
        notice = latest ? `任务 #${latest.id}：${phases[latest.phase] ?? latest.phase}${latest.timeoutNotified ? '（已超出预期时长，仍在查询；未重复执行）' : ''}\n待处理任务：${store.pendingCount(row.conversationKey)}\n结果投递：${delivery.length ? delivery.map(d => ({ sent: '已发送', pending: '待发送', sending: '发送中', unknown: '发送结果未知', failed: '发送失败' })[d.state]).join('、') : '尚无结果'}` : '当前会话还没有任务。';
        if (store.getConversation(row.conversationKey)?.blocked) notice += '\n会话已暂停，管理员可用 /new 开启新会话。';
      } else notice = '暂不支持这个命令。输入 /help 查看可用命令。';
    }
    if (notice) {
      if (Buffer.byteLength(notice) > (this.options.transport.maxMessageBytes ?? 16000)) store.finish(row.id, 'command', notice, this.resultChunks(row, notice));
      else { store.finish(row.id, 'command', notice, []); store.addReply(row.id, notice); }
    }
    else store.addReply(row.id, `已接收任务 #${row.id}，将按顺序执行。`);
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    if (this.stopping) return Promise.resolve();
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  private async runTick(): Promise<void> {
    const { store, config } = this.options;
    await Promise.all(store.active().filter(r => r.nextAt <= this.now()).map(r => this.advance(r)));
    if (this.stopping) return;
    const slots = Math.max(0, config.maxConcurrent - store.active().length);
    if (slots) await Promise.all(store.ready(this.now(), slots).map(r => this.advance(r)));
    if (!this.stopping) await this.deliver();
  }
  private request(row: WorkItem): TriggerRequest {
    const { config, coreBotId, store } = this.options;
    const sessionId = store.getConversation(row.conversationKey)?.sessionId;
    const key = `wecom:${stableKey(row.message.botId, row.message.msgId)}`;
    return {
      source: { type: 'webhook', connectorId: 'wecom', requestId: key },
      target: { kind: 'turn', botId: coreBotId, ...(sessionId ? { sessionId } : {}) },
      envelope: { format: 'text', sourceName: '企业微信', trusted: false,
        payload: { sender: row.message.senderId, chatType: row.message.chatType, text: row.message.text }, rawText: row.message.text },
      instruction: config.instruction, presentation: { topicMessage: null },
      options: { asyncReturnSessionId: true, ...(sessionId ? { turnIdempotencyKey: key } : { idempotencyKey: key }) },
    };
  }
  private async advance(initial: WorkItem): Promise<void> {
    const { store, core, config } = this.options;
    let row = initial;
    try {
      if (row.phase === 'queued') {
        store.prepareSubmission(row.id, this.request(row), this.now());
        row = store.getMessage(row.id)!;
      }
      if (row.phase === 'submitting') {
        if (!row.request) throw new CoreRequestError(false);
        const response = await core.submit(row.request);
        if (!response.ok) { this.fail(row); return; }
        const session = response.target?.sessionId ?? response.async?.sessionId;
        if (!session || !response.triggerId) throw new CoreRequestError(true);
        // A follow-up can never be rebound to a different conversation by a malformed response.
        if (row.request.target.sessionId && row.request.target.sessionId !== session) throw new CoreRequestError(false);
        store.bind(row.id, session, response.triggerId); this.log('submitted', row.id);
        return;
      }
      if (row.phase !== 'running' || !row.sessionId || !row.triggerId) return;
      const response = await core.result(row.sessionId, row.triggerId);
      if (!response.ok || response.state === 'failed' || response.state === 'not_found') { this.fail(row); return; }
      if (response.state === 'completed') {
        if (typeof response.output?.content !== 'string') { this.fail(row); return; }
        const text = response.output.content || '任务执行完成，没有文本输出。';
        store.finish(row.id, 'completed', text, this.resultChunks(row, text)); this.log('completed', row.id);
      } else if (response.state === 'running') {
        if (!row.timeoutNotified && this.now() - (row.submittedAt ?? row.createdAt) > config.taskTimeoutMs) {
          // Do not mark a still-running CLI failed and start concurrent work in its context.
          store.noteTimeout(row.id); this.log('task_overdue', row.id);
        }
        store.defer(row.id, this.now() + config.pollIntervalMs);
      } else throw new CoreRequestError(true);
    } catch (error) {
      if (error instanceof CoreRequestError && !error.retryable) { this.fail(row); return; }
      // Retry the durable request, never synthesize a replacement on transport ambiguity.
      store.defer(row.id, this.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)));
      this.log('core_retry', row.id);
    }
  }
  private resultChunks(row: WorkItem, text: string): string[] {
    const parts = splitUtf8(text, Math.min(14000, (this.options.transport.maxMessageBytes ?? 16000) - 256));
    const sender = row.message.chatType === 'group' ? ` · 发起者 #${stableKey(row.message.senderId).slice(0, 6)}` : '';
    return parts.map((part, i) => `任务 #${row.id}${sender}${parts.length > 1 ? `（${i + 1}/${parts.length}）` : ''}\n\n${part}`);
  }
  private fail(row: WorkItem): void {
    const { store } = this.options;
    const text = '任务执行未能确认完成，未自动重新运行。请用 /status 查看，管理员可在空闲时 /new 新建会话。';
    store.failConversation(row.id, text, (item, content) => this.resultChunks(item, content));
    this.log('failed', row.id);
  }
  private async deliver(): Promise<void> {
    const { store, transport } = this.options;
    const visited = new Set<string>();
    for (const item of store.pendingOutbox(this.now())) {
      if (this.stopping) return;
      if (visited.has(item.conversationKey) || !store.canSend(item.conversationKey, this.now())) continue;
      const predecessors = store.outboxFor(item.messageId).filter(o => o.id < item.id && o.kind === item.kind);
      if (predecessors.some(o => o.state === 'pending' || o.state === 'sending')) continue;
      // A confirmation waiting behind an already complete result is obsolete.
      if (item.kind === 'reply' && ['completed', 'failed'].includes(store.getMessage(item.messageId)!.phase)) {
        store.markDelivery(item.id, 'failed'); continue;
      }
      visited.add(item.conversationKey); store.markSending(item.id, this.now());
      try {
        if (item.kind === 'reply') await transport.reply(item.message, item.content);
        else await transport.send(item.message, item.content);
        store.markDelivery(item.id, 'sent'); this.log('delivered', item.messageId);
      } catch (error) {
        if (error instanceof DeliveryError && error.outcome === 'retryable' && item.attempts < 5) {
          store.markDelivery(item.id, 'pending', this.now() + Math.min(60000, 3000 * 2 ** item.attempts));
        } else store.markDelivery(item.id, error instanceof DeliveryError && error.outcome !== 'unknown' ? 'failed' : 'unknown');
        this.log('delivery_failed', item.messageId);
      }
    }
  }
  async stop(): Promise<void> { this.stopping = true; await this.ticking; }
}
