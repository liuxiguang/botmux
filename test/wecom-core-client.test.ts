import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createCoreClient } from '../src/im/wecom/core-client.js';

it('uses exact trigger ids and preserves request idempotency over the real HTTP boundary', async () => {
  const received: { url: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url!, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, state: 'completed', output: { content: 'fixture answer' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const core = createCoreClient((server.address() as { port: number }).port);
    await core.submit({ source: { type: 'webhook' }, target: { kind: 'turn' }, envelope: { format: 'text', sourceName: 'WeCom', trusted: false }, options: { asyncReturnSessionId: true, idempotencyKey: 'stable-key' } });
    expect((received[0].body as any).options.idempotencyKey).toBe('stable-key');
    expect(await core.result('s/a', 't?1')).toMatchObject({ state: 'completed', output: { content: 'fixture answer' } });
    expect(received[1].url).toBe('/api/sessions/s%2Fa/trigger-result?triggerId=t%3F1');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
