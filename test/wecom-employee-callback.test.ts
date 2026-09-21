import { createCipheriv, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EmployeeCallback } from '../src/im/wecom/employee-callback.js';

const active: EmployeeCallback[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(s => s.stop())); });
const key = Buffer.from('0123456789abcdef0123456789abcdef'), token = 'test-callback-token', corp = 'test-corp';
// Independent platform-side fixture encoder, including WeCom's 32-byte padding.
function encrypted(text: string, recipient = corp) {
  const msg = Buffer.from(text), size = Buffer.alloc(4); size.writeUInt32BE(msg.length);
  const bytes = Buffer.concat([Buffer.alloc(16, 7), size, msg, Buffer.from(recipient)]);
  const padding = 32 - bytes.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
function query(enc: string, time = Math.floor(Date.now() / 1000), nonce = 'nonce') {
  const signature = createHash('sha1').update([token, String(time), nonce, enc].sort().join('')).digest('hex');
  return new URLSearchParams({ timestamp: String(time), nonce, msg_signature: signature });
}
async function fixture() {
  let notifications = 0;
  const callback = new EmployeeCallback({ host: '127.0.0.1', port: 0, path: '/callback' },
    { token, aesKey: key.toString('base64').slice(0, -1), corpId: corp }, () => { notifications++; });
  active.push(callback); const port = await callback.start();
  return { url: `http://127.0.0.1:${port}/callback`, count: () => notifications };
}
describe('employee official archive callback', () => {
  it('decrypts a signed URL verification and only wakes on authentic archive notifications', async () => {
    const f = await fixture(), echo = encrypted('verified'); const params = query(echo); params.set('echostr', echo);
    const verify = await fetch(`${f.url}?${params}`); expect(verify.status).toBe(200); expect(await verify.text()).toBe('verified');
    const content = encrypted(`<xml><ToUserName><![CDATA[${corp}]]></ToUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[msgaudit_notify]]></Event></xml>`);
    const url = `${f.url}?${query(content)}`, body = `<xml><Encrypt><![CDATA[${content}]]></Encrypt></xml>`;
    expect((await fetch(url, { method: 'POST', body })).status).toBe(200); expect(f.count()).toBe(1);
    expect((await fetch(url, { method: 'POST', body })).status).toBe(200); expect(f.count()).toBe(1);
  });
  it('rejects forged signatures, another enterprise, stale events and arbitrary messages', async () => {
    const f = await fixture();
    for (const [text, recipient, timestamp] of [
      ['<xml><MsgType>event</MsgType><Event>msgaudit_notify</Event></xml>', 'other-corp', Math.floor(Date.now() / 1000)],
      ['<xml><MsgType>event</MsgType><Event>msgaudit_notify</Event></xml>', corp, 1],
      ['<xml><MsgType>text</MsgType><Content>run a task</Content></xml>', corp, Math.floor(Date.now() / 1000)],
    ] as const) {
      const enc = encrypted(text, recipient);
      expect((await fetch(`${f.url}?${query(enc, timestamp)}`, { method: 'POST', body: `<xml><Encrypt>${enc}</Encrypt></xml>` })).status).toBe(403);
    }
    const enc = encrypted('hello'), params = query(enc); params.set('msg_signature', '0'.repeat(40)); params.set('echostr', enc);
    expect((await fetch(`${f.url}?${params}`)).status).toBe(403); expect(f.count()).toBe(0);
  });
});
