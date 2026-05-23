/**
 * GIOCORE Bloque 7 — tests del fetcher de consumo de Meta Ads.
 *
 * Mockea `fetch` global y verifica que `fetchMetaUsage` devuelva
 * `ProviderUsageRow[]` con el shape correcto (ver providers/types.ts §contrato
 * y BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §2.1).
 *
 * Ubicación: vitest.config.js incluye `agents/**`/*.test.js`; el repo usa la
 * convención `__tests__/`. Vitest transpila el `.ts` source vía esbuild.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchMetaUsage } from '../meta.ts';

/** Fixture: insight crudo tal como lo devuelve Graph API (valores string). */
function makeInsight(overrides = {}) {
  return {
    spend: '123.45',
    cpc: '0.50',
    cpm: '12.00',
    impressions: '24690',
    clicks: '247',
    actions: [
      { action_type: 'link_click', value: '247' },
      {
        action_type: 'onsite_conversion.messaging_conversation_started_7d',
        value: '18',
      },
    ],
    date_start: '2026-05-21',
    date_stop: '2026-05-21',
    ...overrides,
  };
}

/** Construye una Response-like para el mock de fetch. */
function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const DAY = new Date('2026-05-21T00:00:00.000Z');
const ISO = '2026-05-21';

describe('providers/meta.ts — fetchMetaUsage', () => {
  beforeEach(() => {
    process.env.META_TOKEN = 'test-meta-token';
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('devuelve un ProviderUsageRow[] con una fila por cuenta publicitaria', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ data: [makeInsight()] }));

    const rows = await fetchMetaUsage(DAY);

    expect(Array.isArray(rows)).toBe(true);
    // api/meta.js define 2 cuentas: "nuevo" y "anterior".
    expect(rows).toHaveLength(2);
    // Una llamada fetch por cuenta.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('cada fila tiene el shape de provider_usage', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ data: [makeInsight()] }));

    const [row] = await fetchMetaUsage(DAY);

    expect(row.provider).toBe('meta');
    expect(row.model).toBeNull();
    expect(typeof row.account_id).toBe('string');
    expect(row.account_id).toMatch(/^act_/);
    expect(row.period_start).toBe(ISO);
    expect(row.period_end).toBe(ISO);
    expect(row.cost_usd).toBe(123.45);
    expect(row.requests).toBe(247);
    expect(row.invocations).toBe(24690);
    expect(row.raw_payload).toBeDefined();
  });

  it('raw_payload conserva el insight crudo de la API', async () => {
    const insight = makeInsight();
    global.fetch.mockResolvedValue(jsonResponse({ data: [insight] }));

    const [row] = await fetchMetaUsage(DAY);

    expect(row.raw_payload).toEqual(insight);
  });

  it('usa las 2 cuentas act_ y v20.0 de Graph API en la URL', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ data: [makeInsight()] }));

    await fetchMetaUsage(DAY);

    const urls = global.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('act_299921604429631'))).toBe(true);
    expect(urls.some((u) => u.includes('act_2241343302609141'))).toBe(true);
    for (const u of urls) {
      expect(u).toContain('graph.facebook.com/v20.0');
      expect(u).toContain('time_increment=1');
      expect(u).toContain('insights');
      // time_range acotado al día consultado.
      expect(decodeURIComponent(u)).toContain(`"since":"${ISO}"`);
      expect(decodeURIComponent(u)).toContain(`"until":"${ISO}"`);
    }
  });

  it('el token siempre sale de process.env, nunca hardcodeado', async () => {
    process.env.META_TOKEN = 'token-rotado-xyz';
    global.fetch.mockResolvedValue(jsonResponse({ data: [makeInsight()] }));

    await fetchMetaUsage(DAY);

    const urls = global.fetch.mock.calls.map((c) => String(c[0]));
    for (const u of urls) {
      expect(u).toContain('access_token=token-rotado-xyz');
    }
  });

  it('cuenta sin actividad → fila con cost_usd 0 y raw_payload placeholder', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ data: [] }));

    const rows = await fetchMetaUsage(DAY);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.cost_usd).toBe(0);
      expect(row.requests).toBe(0);
      expect(row.invocations).toBe(0);
      expect(row.raw_payload).toMatchObject({ note: 'sin actividad' });
    }
  });

  it('lanza Error descriptivo si la API responde HTTP no-OK', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(
        { error: { message: 'Invalid OAuth access token' } },
        { ok: false, status: 401, statusText: 'Unauthorized' },
      ),
    );

    await expect(fetchMetaUsage(DAY)).rejects.toThrow(/HTTP 401/);
  });

  it('lanza Error si el body trae un objeto error de Graph API', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ error: { message: 'Application request limit reached' } }),
    );

    await expect(fetchMetaUsage(DAY)).rejects.toThrow(/Application request limit reached/);
  });

  it('lanza Error si falta la env var del token', async () => {
    delete process.env.META_TOKEN;

    await expect(fetchMetaUsage(DAY)).rejects.toThrow(/META_TOKEN/);
  });
});
