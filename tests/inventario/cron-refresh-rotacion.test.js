/**
 * Frente E · tests del cron `/api/cron/refresh-rotacion`.
 *
 * Cubre:
 *   - 401 sin Authorization Bearer CRON_SECRET
 *   - 200 OK invocando RPC `refresh_productos_rotacion` + log en agent_decisions
 *   - 500 cuando RPC falla + intento de notifyFailure (Wapify mock)
 *   - log a agent_decisions falla → no rompe el handler
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let rpcMock;
let insertMock;
let sendWhatsAppMock;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.CRON_SECRET = 'test_cron';
  process.env.WHATSAPP_ISAAC = '+52555';

  rpcMock = vi.fn();
  insertMock = vi.fn();
  sendWhatsAppMock = vi.fn().mockResolvedValue({ ok: true, retries: 0, message_id: 'mock' });
});

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test_cron' },
    ...overrides,
  };
}
function makeRes() {
  return {
    statusCode: null,
    jsonBody: null,
    headers: {},
    setHeader(n, v) { this.headers[n] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn(() => ({
      rpc: rpcMock,
      from: vi.fn(() => ({ insert: insertMock })),
    })),
  }));
  vi.doMock('../../agents/_shared/providers/wapify-notify', () => ({
    sendWhatsApp: sendWhatsAppMock,
  }));
  return (await import('../../api/cron/refresh-rotacion.ts')).default;
}

describe('Frente E · cron/refresh-rotacion', () => {
  it('401 sin Authorization', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('200 OK + invoca RPC + loggea en agent_decisions', async () => {
    rpcMock.mockResolvedValueOnce({ data: { rows: 3860, duration_ms: 280, refreshed_at: '2026-05-25T09:00:00Z' }, error: null });
    insertMock.mockResolvedValueOnce({ error: null });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.rows).toBe(3860);
    expect(rpcMock).toHaveBeenCalledWith('refresh_productos_rotacion');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rotacion_refresh',
      payload: expect.objectContaining({ rows: 3860 }),
      severity: 0.1,
    }));
  });

  it('500 + notifyFailure cuando RPC falla', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'lock timeout' } });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.error).toBe('lock timeout');
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMock.mock.calls[0][1]).toContain('lock timeout');
  });

  it('log a agent_decisions falla → handler sigue siendo 200', async () => {
    rpcMock.mockResolvedValueOnce({ data: { rows: 100, duration_ms: 50 }, error: null });
    insertMock.mockResolvedValueOnce({ error: { message: 'rls denied' } });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
  });

  it('Cache-Control no-store', async () => {
    rpcMock.mockResolvedValueOnce({ data: { rows: 100 }, error: null });
    insertMock.mockResolvedValueOnce({ error: null });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.headers['Cache-Control']).toContain('no-store');
  });
});
