/**
 * GIOCORE Bloque 7 — tests unit del fetcher Wapify (Vitest).
 *
 * `fetch` mockeado con `vi.fn()` (sin red real). Verifica el shape de
 * `ProviderUsageRow[]` que `fetchWapifyUsage` devuelve.
 *
 * Ubicación `agents/_shared/providers/__tests__/` para que lo recoja el glob
 * de `vitest.config.js` (archivos `.test.js` bajo `agents/`), igual que meta.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchWapifyUsage } from '../wapify';

const DAY = new Date('2026-05-21T00:00:00.000Z');
const ISO = '2026-05-21';

/** Construye una Response-like para el mock de fetch. */
function mockResponse(body, { ok = true, status = 200, json = true } = {}) {
  return {
    ok,
    status,
    json: json
      ? async () => body
      : async () => {
          throw new Error('cuerpo no-JSON');
        },
  };
}

describe('fetchWapifyUsage', () => {
  const ORIGINAL_TOKEN = process.env.WAPIFY_TOKEN;

  beforeEach(() => {
    process.env.WAPIFY_TOKEN = 'test-token-1187373.fake';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.WAPIFY_TOKEN;
    else process.env.WAPIFY_TOKEN = ORIGINAL_TOKEN;
    vi.restoreAllMocks();
  });

  it('lanza si WAPIFY_TOKEN no está definido', async () => {
    delete process.env.WAPIFY_TOKEN;
    await expect(fetchWapifyUsage(DAY)).rejects.toThrow(/WAPIFY_TOKEN/);
  });

  it('cuenta mensajes de una sola página (payload con clave `data`)', async () => {
    const msgs = Array.from({ length: 7 }, (_, i) => ({ id: i }));
    global.fetch = vi.fn(async () => mockResponse({ data: msgs }));

    const rows = await fetchWapifyUsage(DAY);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.provider).toBe('wapify');
    expect(row.model).toBeNull();
    expect(row.messages_sent).toBe(7);
    expect(row.period_start).toBe(ISO);
    expect(row.period_end).toBe(ISO);
    // Estimación USD: 7 * 0.005 = 0.035
    expect(row.cost_usd).toBeCloseTo(0.035, 6);
    expect(row.account_id).toBe('1187373');
    expect(row.raw_payload).toBeTruthy();
  });

  it('pasa el header X-ACCESS-TOKEN y filtra por la fecha del día', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: [] }));
    global.fetch = fetchMock;

    await fetchWapifyUsage(DAY);

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://ap.whapify.ai/api/messages');
    expect(url).toContain(`date_from=${ISO}`);
    expect(url).toContain(`date_to=${ISO}`);
    expect(init.headers['X-ACCESS-TOKEN']).toBe('test-token-1187373.fake');
  });

  it('pagina: suma mensajes de varias páginas hasta una página incompleta', async () => {
    // Página 1 y 2 llenas (100 c/u), página 3 incompleta (12) => total 212.
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const partial = Array.from({ length: 12 }, (_, i) => ({ id: i }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ data: full }))
      .mockResolvedValueOnce(mockResponse({ data: full }))
      .mockResolvedValueOnce(mockResponse({ data: partial }));
    global.fetch = fetchMock;

    const rows = await fetchWapifyUsage(DAY);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows[0].messages_sent).toBe(212);
    expect(rows[0].cost_usd).toBeCloseTo(212 * 0.005, 6);
  });

  it('respeta has_more=false para cortar la paginación', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ data: full, has_more: false }));
    global.fetch = fetchMock;

    const rows = await fetchWapifyUsage(DAY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows[0].messages_sent).toBe(100);
  });

  it('HTTP no-OK => messages_sent 0 con nota en raw_payload (no inventa datos)', async () => {
    global.fetch = vi.fn(async () => mockResponse(null, { ok: false, status: 401 }));

    const rows = await fetchWapifyUsage(DAY);

    expect(rows).toHaveLength(1);
    expect(rows[0].messages_sent).toBe(0);
    expect(rows[0].cost_usd).toBe(0);
    const raw = rows[0].raw_payload;
    expect(String(raw.note)).toMatch(/401/);
  });

  it('cuerpo no-JSON => messages_sent 0 con nota', async () => {
    global.fetch = vi.fn(async () => mockResponse(null, { json: false }));

    const rows = await fetchWapifyUsage(DAY);

    expect(rows[0].messages_sent).toBe(0);
    const raw = rows[0].raw_payload;
    expect(String(raw.note)).toMatch(/no-JSON/);
  });

  it('objeto de error de Wapify (endpoint inexistente) => messages_sent 0 con nota', async () => {
    // Caso real confirmado en discovery C1.5: HTTP 200 con {"error":{"code":404}}.
    global.fetch = vi.fn(async () =>
      mockResponse({ error: { code: 404, message: "doesn't exist" } }),
    );

    const rows = await fetchWapifyUsage(DAY);

    expect(rows[0].messages_sent).toBe(0);
    const raw = rows[0].raw_payload;
    expect(String(raw.note)).toMatch(/error/i);
  });

  it('shape de respuesta irreconocible => messages_sent 0 con nota', async () => {
    global.fetch = vi.fn(async () => mockResponse({ unexpected: 'shape' }));

    const rows = await fetchWapifyUsage(DAY);

    expect(rows[0].messages_sent).toBe(0);
    const raw = rows[0].raw_payload;
    expect(String(raw.note)).toMatch(/array de mensajes/);
  });

  it('fallo de red => degrada con elegancia (no lanza)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const rows = await fetchWapifyUsage(DAY);

    expect(rows).toHaveLength(1);
    expect(rows[0].messages_sent).toBe(0);
    expect(rows[0].provider).toBe('wapify');
    const raw = rows[0].raw_payload;
    expect(String(raw.note)).toMatch(/ECONNREFUSED/);
  });

  it('payload como array crudo también se cuenta', async () => {
    global.fetch = vi.fn(async () => mockResponse([{ id: 1 }, { id: 2 }, { id: 3 }]));

    const rows = await fetchWapifyUsage(DAY);
    expect(rows[0].messages_sent).toBe(3);
  });
});
