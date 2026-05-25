/**
 * Frente E · tests del helper `sendWhatsApp` (agents/_shared/providers/wapify-notify.ts).
 *
 * Cubre los quirks de Wapify:
 *   - HTTP 200 con `{error:{code:429}}` (body-level) → retry con backoff
 *   - HTTP 5xx → retry; HTTP 4xx → terminal
 *   - Token ausente → error inmediato sin red
 *   - maxRetries respeta cap
 *   - sleepFn inyectable (no sleep real en tests)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendWhatsApp } from '../../agents/_shared/providers/wapify-notify.ts';

const ORIG_FETCH = globalThis.fetch;

function makeRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  process.env.WAPIFY_TOKEN = 'test_token';
  globalThis.fetch = vi.fn();
});

describe('Frente E · wapify-notify · sendWhatsApp', () => {
  it('200 con message_id → ok=true en primer intento', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeRes(200, { message_id: 'm1' }));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.message_id).toBe('m1');
    expect(r.retries).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('body-level 429 → retry con backoff y eventually success', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeRes(200, { error: { code: 429, message: 'rate' } }))
      .mockResolvedValueOnce(makeRes(200, { error: { code: 429, message: 'rate' } }))
      .mockResolvedValueOnce(makeRes(200, { message_id: 'm2' }));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.retries).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('body-level 503 → retry; agota maxRetries y devuelve ok=false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeRes(200, { error: { code: 503, message: 'down' } }));
    const r = await sendWhatsApp('+52111', 'hola', { maxRetries: 2, sleepFn: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.body_error_code).toBe(503);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // intento 0 + 2 retries
  });

  it('body-level 404 (terminal) → ok=false sin retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeRes(200, { error: { code: 404, message: 'not found' } }));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.body_error_code).toBe(404);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP 500 → retry; 200 final → ok=true', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeRes(500, {}))
      .mockResolvedValueOnce(makeRes(200, { message_id: 'm3' }));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.retries).toBe(1);
  });

  it('HTTP 400 (no 5xx) → ok=false sin retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeRes(400, {}));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.http_status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('WAPIFY_TOKEN ausente → ok=false sin pegar a red', async () => {
    delete process.env.WAPIFY_TOKEN;
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WAPIFY_TOKEN/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('numero/mensaje vacíos → ok=false sin red', async () => {
    const r1 = await sendWhatsApp('', 'hola', { sleepFn: async () => {} });
    expect(r1.ok).toBe(false);
    const r2 = await sendWhatsApp('+52111', '', { sleepFn: async () => {} });
    expect(r2.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('network error (throw) → retry y eventual éxito', async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeRes(200, { message_id: 'mN' }));
    const r = await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.retries).toBe(1);
  });

  it('header X-ACCESS-TOKEN + body JSON con account_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, { message_id: 'mH' }));
    globalThis.fetch = fetchMock;
    await sendWhatsApp('+52111', 'hola', { sleepFn: async () => {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/send-message$/);
    expect(init.headers['X-ACCESS-TOKEN']).toBe('test_token');
    expect(init.headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(init.body);
    expect(parsed.account_id).toBe('1187373');
    expect(parsed.phone).toBe('+52111');
    expect(parsed.message).toBe('hola');
  });
});

// Restore fetch al final del archivo
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

import { afterEach } from 'vitest';
