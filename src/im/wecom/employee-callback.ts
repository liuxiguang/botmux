import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CallbackCredentials, EmployeeConfig } from './config.js';

function field(xml: string, name: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('invalid XML');
  const matches = [...xml.matchAll(new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${name}>`, 'g'))];
  if (matches.length !== 1) throw new Error('invalid XML field');
  return (matches[0][1] ?? matches[0][2]).trim();
}

/** Official encrypted msgaudit_notify receiver. It carries a wakeup, never a prompt. */
export class EmployeeCallback {
  private server?: Server;
  private seen = new Map<string, number>();
  constructor(private config: NonNullable<EmployeeConfig['callback']>, private credentials: CallbackCredentials,
    private notify: () => void, private now: () => number = Date.now) {}

  private decrypt(ciphertext: string, params: URLSearchParams): string {
    const time = params.get('timestamp') ?? '', nonce = params.get('nonce') ?? '', signature = params.get('msg_signature') ?? '';
    if (!/^\d{1,12}$/.test(time) || Math.abs(Number(time) * 1000 - this.now()) > 300000 || !nonce || nonce.length > 256
      || !/^[a-f0-9]{40}$/i.test(signature) || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) throw new Error('invalid authentication');
    const expected = createHash('sha1').update([this.credentials.token, time, nonce, ciphertext].sort().join('')).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid signature');
    const key = Buffer.from(this.credentials.aesKey + '=', 'base64'), bytes = Buffer.from(ciphertext, 'base64');
    if (key.length !== 32 || !bytes.length || bytes.length % 16) throw new Error('invalid cipher');
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(bytes), decipher.final()]);
    const padding = padded[padded.length - 1];
    if (padding < 1 || padding > 32 || !padded.subarray(-padding).every(v => v === padding)) throw new Error('invalid padding');
    const plaintext = padded.subarray(0, -padding);
    if (plaintext.length < 20) throw new Error('invalid envelope');
    const length = plaintext.readUInt32BE(16);
    if (length > plaintext.length - 20 || plaintext.subarray(20 + length).toString('utf8') !== this.credentials.corpId) throw new Error('invalid recipient');
    return plaintext.subarray(20, 20 + length).toString('utf8');
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('x-content-type-options', 'nosniff');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.config.path) { res.writeHead(404).end(); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      if (req.method === 'GET') {
        const echo = url.searchParams.get('echostr') ?? '';
        if (echo.length > 65536) throw new Error('oversized');
        res.end(this.decrypt(echo, url.searchParams)); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const ciphertext = field(Buffer.concat(chunks).toString('utf8'), 'Encrypt');
      const xml = this.decrypt(ciphertext, url.searchParams);
      if (field(xml, 'ToUserName') !== this.credentials.corpId || field(xml, 'MsgType') !== 'event' || field(xml, 'Event') !== 'msgaudit_notify') throw new Error('not an archive notification');
      for (const [key, expires] of this.seen) if (expires < this.now()) this.seen.delete(key);
      const key = createHash('sha256').update(ciphertext).digest('hex');
      if (!this.seen.has(key)) {
        if (this.seen.size >= 5000) { res.writeHead(429).end(); return; }
        this.notify(); this.seen.set(key, this.now() + 600000);
      }
      res.end('success');
    } catch { if (!res.headersSent) res.writeHead(403); res.end(); }
  }
  async start(): Promise<number> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.config.port, this.config.host, resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('回调端口启动失败');
    return address.port;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
