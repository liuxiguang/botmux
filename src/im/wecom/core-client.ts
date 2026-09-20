import type { TriggerRequest, TriggerResponse } from '../../services/trigger-types.js';

export interface CoreClient {
  submit(request: TriggerRequest): Promise<TriggerResponse>;
  result(sessionId: string, triggerId: string): Promise<TriggerResponse>;
}
export class CoreRequestError extends Error {
  constructor(readonly retryable: boolean) { super('core-only 请求失败'); }
}

export function createCoreClient(port: number, timeoutMs = 15000): CoreClient {
  const base = `http://127.0.0.1:${port}`;
  async function request(path: string, body?: TriggerRequest): Promise<TriggerResponse> {
    let response: Response;
    try {
      response = await fetch(base + path, { method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch { throw new CoreRequestError(true); }
    if (response.status === 503 || response.status === 429 || response.status >= 500) throw new CoreRequestError(true);
    // An unexpected response can follow successful dispatch; keep the same key on retry.
    let value: TriggerResponse;
    try { value = await response.json() as TriggerResponse; } catch { throw new CoreRequestError(true); }
    if (!value || typeof value.ok !== 'boolean') throw new CoreRequestError(true);
    if (!response.ok && value.ok) throw new CoreRequestError(false);
    return value;
  }
  return {
    submit: body => request('/api/trigger', body),
    result: (session, trigger) => request(`/api/sessions/${encodeURIComponent(session)}/trigger-result?triggerId=${encodeURIComponent(trigger)}`),
  };
}
