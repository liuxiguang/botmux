/**
 * Behavioral coverage for the async-HTTP "settle-on-terminal" fix (core-only
 * completion bug #70).
 *
 * A turn the worker's bridge gate suppressed as GENUINE SILENCE (model
 * terminated with a bare nothing-to-send sentinel, no `botmux send`) emits
 * `turn_terminal` but NO `final_output`. Without a settle path the async-trigger
 * result stays `pending` and the HTTP poller hangs `running` until timeout.
 *
 * The fix settles such a turn to completed-with-empty-output — but ONLY on the
 * worker's explicit positive evidence `outputDisposition: 'nothing_to_send'`,
 * never on a bare `completed` terminal (the RPC-hydration timeout path emits a
 * bare `completed` with no final_output while the real answer is still
 * materializing; settling that empty would mask a lost reply).
 *
 * These drive the real worker-pool IPC handler via __testOnly_setupWorkerHandlers
 * + a fake worker (mirrors bridge-final-output-retry.test.ts) so the guards are
 * exercised, not just pinned in source.
 *
 * Run:  pnpm vitest run test/async-terminal-settle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let stateDir: string;

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return stateDir; } },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// Spy the durable store so we assert persistence intent without touching disk.
const recordCompletedMock = vi.fn();
const recordTerminalFailureStrictMock = vi.fn(() => 'written_failed');
vi.mock('../src/services/async-trigger-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/async-trigger-store.js')>();
  return {
    ...actual,
    recordCompleted: (...args: any[]) => recordCompletedMock(...args),
    recordTerminalFailureStrict: (...args: any[]) => recordTerminalFailureStrictMock(...args),
  };
});

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { lookupStrict, recordPending } from '../src/services/async-trigger-store.js';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-async-settle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'claude-code',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
  return ds;
}

function terminalMsg(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-async-settle',
    turnId,
    status: 'completed',
    ...extra,
  };
}

describe('async-HTTP settle-on-terminal (daemon turn_terminal handler)', () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'async-silent-settle-'));
    recordCompletedMock.mockClear();
    recordTerminalFailureStrictMock.mockClear();
    recordTerminalFailureStrictMock.mockReturnValue('written_failed');
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); rmSync(stateDir, { recursive: true, force: true }); });

  function signedSilentFixture(disposition: boolean = true) {
    const ds = makeDs();
    ds.session.cliId = 'codex-app';
    ds.chatId = 'http_async_silent';
    ds.asyncTriggerResults = new Map([['turn-signed-silent', { status: 'pending', createdAt: 1 }]]);
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-silent', turnId: 'turn-signed-silent',
      state: 'prepared', content: 'request', deliverySink: 'http_async',
    }];
    recordPending(ds.session.sessionId, 'turn-signed-silent', 1, ds.larkAppId);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const message: Extract<WorkerToDaemon, { type: 'final_output' }> = {
      type: 'final_output', sessionId: ds.session.sessionId, turnId: 'turn-signed-silent',
      lastUuid: 'turn-signed-silent', content: '', suppressDelivery: true,
      codexAppSettlement: {
        requestId: 'settle-silent', generation: 'generation-silent', seq: 1, dispatchId: 'dispatch-silent',
        ...(disposition ? { outputDisposition: 'nothing_to_send' as const } : {}),
      },
    };
    return { ds, message };
  }

  it.each([false, true])('persists signed Codex silence before ACK without a later terminal (recovered=%s)', async recovered => {
    const { ds, message } = signedSilentFixture();
    if (recovered) ds.asyncTriggerResults = undefined;
    let resultAtAck: unknown;
    (ds.worker as any).send.mockImplementation((reply: any) => {
      if (reply.type === 'codex_app_dispatch_persisted' && reply.ok) {
        resultAtAck = lookupStrict(ds.session.sessionId, message.turnId)?.result;
      }
    });
    (ds.worker as any).emit('message', message);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
    await vi.waitFor(() => expect(resultAtAck).toBeDefined());
    expect(resultAtAck).toMatchObject({ status: 'completed', content: '' });
    expect(ds.asyncTriggerResults!.get(message.turnId)).toMatchObject({ status: 'completed', content: '' });
    // Model a daemon restart: the public result survives loss of its memory map.
    ds.asyncTriggerResults = undefined;
    expect(lookupStrict(ds.session.sessionId, message.turnId)?.result).toMatchObject({ status: 'completed', content: '' });
  });

  it('includes silence evidence in the daemon-synthesized durable terminal before ACK', async () => {
    const terminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal: terminal,
    } as any);
    const { ds, message } = signedSilentFixture();
    message.dispatchAttempt = 2;
    ds.session.codexAppDispatchLedger![0].dispatchAttempt = 2;
    (ds.worker as any).emit('message', message);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(terminal).toHaveBeenCalledWith(ds, expect.objectContaining({
      type: 'turn_terminal', status: 'completed', turnId: message.turnId,
      dispatchAttempt: 2, outputDisposition: 'nothing_to_send',
    }), expect.anything());
  });

  it('leaves generic suppressed/empty Codex finals pending without positive silence evidence', async () => {
    const { ds, message } = signedSilentFixture(false);
    (ds.worker as any).emit('message', message);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
    expect(lookupStrict(ds.session.sessionId, message.turnId)?.result.status).toBe('pending');
  });

  it('retains the signed dispatch and negative ACKs when silence cannot be durably stored', async () => {
    const { ds, message } = signedSilentFixture();
    const path = join(stateDir, 'async-triggers', `${ds.session.sessionId}.json`);
    rmSync(path); mkdirSync(path);
    (ds.worker as any).emit('message', message);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'codex_app_dispatch_persisted', requestId: 'settle-silent', ok: false,
    })));
    expect(ds.session.codexAppDispatchLedger).toHaveLength(1);
    expect(ds.asyncTriggerResults!.get(message.turnId)?.status).toBe('pending');
    // The exact signed final is replayable once storage is repaired.
    rmSync(path, { recursive: true });
    (ds.worker as any).emit('message', message);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
    expect(lookupStrict(ds.session.sessionId, message.turnId)?.result.status).toBe('completed');
  });

  it('settles a pending async result to completed+empty on a nothing_to_send terminal', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-silent', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([['turn-silent', { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-silent', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => {
      const r = ds.asyncTriggerResults!.get('turn-silent')!;
      expect(r.status).toBe('completed');
      expect(r.content).toBe('');
    });
    // Durable persistence with EMPTY content.
    expect(recordCompletedMock).toHaveBeenCalledWith(
      'sid-async-settle', 'turn-silent', '', expect.any(Number), 'app_test',
    );
    // Worker-exit convergence entry dropped (by triggerId) so a later graceful exit can't retro-fail it.
    expect(ds.idempotentAsyncTurns!.get('turn-silent')).toBeUndefined();
  });

  it('does NOT settle on a bare completed terminal (no disposition) — the RPC-hydration-timeout case', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-bare', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([['turn-bare', { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Bare completed: no outputDisposition. A real answer may still be materializing.
    (ds.worker as any).emit('message', terminalMsg('turn-bare'));

    // Give the async IPC handler a tick to run.
    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-bare')!;
    expect(r.status).toBe('pending');          // untouched — must not fabricate empty output
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(ds.idempotentAsyncTurns!.get('turn-bare')).toBeDefined(); // convergence entry intact
  });

  it('settles a failed terminal immediately and persists its provider code', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-failed', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([[
      'turn-failed',
      { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-failed', {
      status: 'failed', errorCode: 'provider_unexpected_eof', retryable: true,
    }));

    await vi.waitFor(() => {
      expect(ds.asyncTriggerResults!.get('turn-failed')).toMatchObject({
        status: 'failed',
        errorCode: 'trigger_failed',
        terminalErrorCode: 'provider_unexpected_eof',
      });
    });
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(recordTerminalFailureStrictMock).toHaveBeenCalledWith(
      'sid-async-settle',
      'turn-failed',
      expect.any(Number),
      'app_test',
      'provider_unexpected_eof',
    );
    expect(ds.idempotentAsyncTurns!.has('turn-failed')).toBe(false);
  });

  it('rejects an HTTP wait immediately with the structured provider failure', async () => {
    const ds = makeDs();
    ds.chatId = 'http_wait_fixture';
    const resolve = vi.fn();
    const reject = vi.fn();
    ds.pendingWaitPromises = new Map([['turn-wait', { resolve, reject }]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-wait', {
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    }));

    await vi.waitFor(() => expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Claude turn failed: provider_server_error' }),
    ));
    expect(resolve).not.toHaveBeenCalled();
    expect(ds.pendingWaitPromises.has('turn-wait')).toBe(false);
  });

  it('does NOT clobber a final_output-completed result (pending-only guard)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([[
      'turn-done', { status: 'completed', content: 'real answer' } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-done', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-done')!;
    expect(r.status).toBe('completed');
    expect(r.content).toBe('real answer');       // NOT overwritten with ''
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('keeps final_output completion stronger than a later failed terminal', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([[
      'turn-output-won',
      { status: 'completed', content: 'real answer', completedAt: Date.now() } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-output-won', {
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults.get('turn-output-won')).toMatchObject({
      status: 'completed',
      content: 'real answer',
    });
    expect(recordTerminalFailureStrictMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a Feishu turn (no asyncTriggerResults entry)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map();          // Feishu turn: no async entry
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-feishu', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults!.has('turn-feishu')).toBe(false);
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });
});
