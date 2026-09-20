import { WebSocketServer, type WebSocket } from 'ws';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { SdkWecomTransport } from '../src/im/wecom/transport.js';
import type { WecomMessage } from '../src/im/wecom/message.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function server(auth = true) {
  const frames: any[] = []; let socket: WebSocket;
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(ws, 'listening');
  cleanup.push(async () => { ws.clients.forEach(s => s.terminate()); await new Promise<void>(r => ws.close(() => r())); });
  let errcode = 0, closeOnSend = false;
  ws.on('connection', s => { socket = s; s.on('message', bytes => {
    const f = JSON.parse(bytes.toString()); frames.push(f);
    if (f.cmd === 'aibot_subscribe') { if (auth) s.send(JSON.stringify({ headers: f.headers, errcode: 0 })); }
    else if (closeOnSend) s.terminate();
    else s.send(JSON.stringify({ headers: f.headers, errcode, errmsg: 'fixture' }));
  }); });
  return { frames, url: `ws://127.0.0.1:${(ws.address() as { port: number }).port}`, push: (f: unknown) => socket.send(JSON.stringify(f)), setError: (n: number) => { errcode = n; }, drop: () => { closeOnSend = true; } };
}
const msg: WecomMessage = { botId: 'bot', msgId: 'message', reqId: 'incoming', chatType: 'group', chatId: 'group', senderId: 'user', kind: 'text', text: 'hello' };
describe('official WeCom SDK transport', () => {
  it('authenticates, receives callbacks, finishes a reply and sends a group result', async () => {
    const s = await server(); const seen: unknown[] = [];
    const transport = new SdkWecomTransport({ botId: 'bot', secret: 'secret' }, { wsUrl: s.url, onMessage: f => { seen.push(f); } });
    cleanup.push(async () => transport.stop()); await transport.start();
    s.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'incoming' }, body: { aibotid: 'bot', msgid: 'message', chattype: 'group', chatid: 'group', from: { userid: 'user' }, msgtype: 'text', text: { content: 'hello' } } });
    await new Promise(r => setTimeout(r, 10)); expect(seen).toHaveLength(1);
    await transport.reply(msg, 'accepted'); await transport.send(msg, 'answer');
    expect(s.frames[1]).toMatchObject({ cmd: 'aibot_respond_msg', headers: { req_id: 'incoming' }, body: { msgtype: 'stream', stream: { content: 'accepted', finish: true } } });
    expect(s.frames[2]).toMatchObject({ cmd: 'aibot_send_msg', body: { chatid: 'group', msgtype: 'markdown', markdown: { content: 'answer' } } });
  });
  it('distinguishes definite rejection from a connection lost before acknowledgement', async () => {
    const s = await server(); const transport = new SdkWecomTransport({ botId: 'bot', secret: 'secret' }, { wsUrl: s.url });
    cleanup.push(async () => transport.stop()); await transport.start();
    s.setError(400); await expect(transport.send(msg, 'answer')).rejects.toMatchObject({ outcome: 'rejected' });
    s.drop(); await expect(transport.send(msg, 'answer')).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('times out missing authentication and stops on a takeover event', async () => {
    const s = await server(false); const timeout = new SdkWecomTransport({ botId: 'bot', secret: 'secret' }, { wsUrl: s.url, authTimeoutMs: 30 });
    cleanup.push(async () => timeout.stop()); await expect(timeout.start()).rejects.toThrow('认证');
    const live = await server(); const transport = new SdkWecomTransport({ botId: 'bot', secret: 'secret' }, { wsUrl: live.url });
    cleanup.push(async () => transport.stop()); await transport.start();
    live.push({ cmd: 'aibot_event_callback', headers: { req_id: 'takeover' }, body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } } });
    await expect(transport.closed).resolves.toBe('connection_replaced');
  });
});
