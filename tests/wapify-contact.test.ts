/**
 * tests/wapify-contact.test.ts — lookup PII single-shot del CRM Whapify.
 *
 * Blinda que fetchContactPII:
 *   - Es BEST-EFFORT: ante CUALQUIER fallo (token ausente, red, timeout, 404,
 *     rate-limit, body raro) devuelve null y NUNCA lanza (no rompe la captura).
 *   - Normaliza nombre (full_name, o first+last) y teléfono; "" → null.
 *   - Tolera el quirk Whapify de HTTP 200 con body {error:{...}}.
 *   - Manda el header X-ACCESS-TOKEN y pega al endpoint correcto.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchContactPII } from '../agents/_shared/providers/wapify-contact.ts';

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}

let fetchCalls: Array<{ url: string; init: any }>;
function installFetch(impl: (url: string) => unknown) {
  fetchCalls = [];
  global.fetch = vi.fn(async (url: unknown, init: unknown) => {
    fetchCalls.push({ url: String(url), init });
    return impl(String(url));
  }) as unknown as typeof fetch;
}

describe('fetchContactPII — lookup CRM Whapify best-effort', () => {
  beforeEach(() => {
    process.env.WAPIFY_TOKEN = 'test_token_xyz';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as { fetch?: unknown }).fetch;
    delete process.env.WAPIFY_TOKEN;
  });

  it('contacto OK con full_name + phone → devuelve nombre y teléfono', async () => {
    installFetch(() => jsonResponse({ id: 'c1', full_name: 'Juan Pérez', phone: '+526641234567', email: 'j@x.com' }));
    const r = await fetchContactPII('c1');
    expect(r).toEqual({ nombre: 'Juan Pérez', telefono: '+526641234567' });
  });

  it('sin full_name → compone first_name + last_name', async () => {
    installFetch(() => jsonResponse({ first_name: 'Ana', last_name: 'López', phone: '6640000000' }));
    const r = await fetchContactPII('c2');
    expect(r?.nombre).toBe('Ana López');
  });

  it('strings vacíos ("") → null (quirk Whapify)', async () => {
    installFetch(() => jsonResponse({ full_name: '', first_name: '', last_name: '', phone: '' }));
    const r = await fetchContactPII('c3');
    expect(r).toEqual({ nombre: null, telefono: null });
  });

  it('manda header X-ACCESS-TOKEN y pega a /contacts/{id} (id url-encoded)', async () => {
    installFetch(() => jsonResponse({ full_name: 'X', phone: '1' }));
    await fetchContactPII('a b/c');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://ap.whapify.ai/api/contacts/a%20b%2Fc');
    expect(fetchCalls[0].init.headers['X-ACCESS-TOKEN']).toBe('test_token_xyz');
  });

  // ── Degradación: SIEMPRE null, nunca throw ──────────────────────────────────
  it('sin WAPIFY_TOKEN → null sin pegarle a la red', async () => {
    delete process.env.WAPIFY_TOKEN;
    installFetch(() => jsonResponse({ full_name: 'no debería' }));
    const r = await fetchContactPII('c1');
    expect(r).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it('contactId vacío → null sin red', async () => {
    installFetch(() => jsonResponse({}));
    const r = await fetchContactPII('');
    expect(r).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it('HTTP 404 → null', async () => {
    installFetch(() => jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));
    expect(await fetchContactPII('c1')).toBeNull();
  });

  it('HTTP 200 con body {error:{code}} (quirk) → null', async () => {
    installFetch(() => jsonResponse({ error: { code: 429, message: 'rate limit' } }));
    expect(await fetchContactPII('c1')).toBeNull();
  });

  it('body no-JSON → null', async () => {
    installFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    expect(await fetchContactPII('c1')).toBeNull();
  });

  it('fetch lanza (red/timeout) → null, no propaga', async () => {
    installFetch(() => { throw new Error('ECONNRESET'); });
    await expect(fetchContactPII('c1')).resolves.toBeNull();
  });
});
