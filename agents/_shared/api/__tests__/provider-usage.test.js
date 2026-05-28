/**
 * GIOCORE Bloque 7 — tests del endpoint `api/provider-usage.ts`.
 *
 * Cubre:
 *  (a) parsing de query params (provider, days, defaults, max)
 *  (b) shape de response coincide con spec §4 (kpis/by_day/by_model/range)
 *  (c) provider=wapify devuelve el bypass D2=a sin tocar DB
 *  (d) cálculo de delta_pct correcto (incluido edge case prev=0)
 *
 * Mockea `@supabase/supabase-js` para inyectar filas determinísticas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ── Mocks hoisted ──────────────────────────────────────────────────────── */

const mocks = vi.hoisted(() => {
  /**
   * Fila simulada (shape igual a la query SELECT del handler).
   * `rowsToReturn` se sobreescribe por cada test antes de invocar al handler.
   */
  let rowsToReturn = [];
  let errorToReturn = null;

  // Tracker de filtros aplicados (para verificar parsing de params).
  const calls = {
    selects: [], // [{ filters: { eq, gte, lte }, order }]
  };

  function makeQueryBuilder() {
    const state = { filters: { eq: {}, gte: null, lte: null, in: null }, order: null };
    const builder = {
      select(_cols) {
        return builder;
      },
      eq(col, val) {
        state.filters.eq[col] = val;
        return builder;
      },
      in(col, vals) {
        state.filters.in = { col, vals };
        return builder;
      },
      gte(col, val) {
        state.filters.gte = { col, val };
        return builder;
      },
      lte(col, val) {
        state.filters.lte = { col, val };
        return builder;
      },
      order(col, opts) {
        state.order = { col, opts };
        calls.selects.push(state);
        // El terminal de la cadena devuelve la promesa con data/error.
        return Promise.resolve({ data: rowsToReturn, error: errorToReturn });
      },
    };
    return builder;
  }

  const supabaseClient = {
    from(_table) {
      return makeQueryBuilder();
    },
  };

  return {
    calls,
    setRows(rows) {
      rowsToReturn = rows;
    },
    setError(err) {
      errorToReturn = err;
    },
    createClient: vi.fn(() => supabaseClient),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

/* ── Helpers ────────────────────────────────────────────────────────────── */

function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    ended: false,
    headers: {},
    status(code) {
      r.statusCode = code;
      return r;
    },
    json(body) {
      r.body = body;
      return r;
    },
    setHeader(name, value) {
      r.headers[name] = value;
      return r;
    },
    end() {
      r.ended = true;
      return r;
    },
  };
  return r;
}

function makeReq(query = {}) {
  return { query, headers: {}, method: 'GET' };
}

/* ── Suite ──────────────────────────────────────────────────────────────── */

describe('api/provider-usage.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.selects.length = 0;
    mocks.setRows([]);
    mocks.setError(null);
    mocks.createClient.mockClear();

    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    // Fijar "ahora" para que from/to/prevFrom sean determinísticas.
    // 2026-05-22 → days=30 → from=2026-04-22, prevFrom=2026-03-23.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/provider-usage.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ── (a) Parsing de query params ────────────────────────────────────── */

  describe('(a) parsing de query params', () => {
    it('sin provider devuelve agregado 200 de KNOWN_PROVIDERS', async () => {
      // Contrato actual del handler (api/provider-usage.ts:159):
      // "Si no se pasa ?provider devolver agregado de todos los providers conocidos"
      // No es 400 — el modo agregado es válido para dashboards multi-provider.
      mocks.setRows([]);
      const req = makeReq({});
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('kpis');
      expect(res.body).toHaveProperty('by_day');
      // Verifica que .in() fue llamado con KNOWN_PROVIDERS
      const lastCall = mocks.calls.selects[mocks.calls.selects.length - 1];
      expect(lastCall?.filters?.in?.col).toBe('provider');
      expect(Array.isArray(lastCall?.filters?.in?.vals)).toBe(true);
    });

    it('usa days=30 por default', async () => {
      mocks.setRows([]);
      const req = makeReq({ provider: 'meta' });
      const res = makeRes();
      await handler(req, res);
      // Para "hoy"=2026-05-22 y days=30 → from=2026-04-22.
      expect(res.body.range).toEqual({ from: '2026-04-22', to: '2026-05-22' });
    });

    it('respeta days=7', async () => {
      mocks.setRows([]);
      const req = makeReq({ provider: 'meta', days: '7' });
      const res = makeRes();
      await handler(req, res);
      expect(res.body.range).toEqual({ from: '2026-05-15', to: '2026-05-22' });
    });

    it('parsea provider y days desde req.url si req.query está vacío', async () => {
      mocks.setRows([]);
      const req = { url: '/api/provider-usage?provider=meta&days=7', method: 'GET', headers: {} };
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.range).toEqual({ from: '2026-05-15', to: '2026-05-22' });
    });
  });

  /* ── (b) Shape de response ──────────────────────────────────────────── */

  describe('(b) shape de response coincide con spec §4', () => {
    it('devuelve provider/range/kpis/by_day/by_model', async () => {
      mocks.setRows([
        // Período actual (>= from = 2026-04-22)
        {
          period_start: '2026-05-22',
          model: 'claude-haiku-4-5',
          cost_usd: 6.12,
          tokens_in: 800000,
          tokens_in_cached: 20000,
          tokens_out: 1345,
          requests: 50,
          messages_sent: 0,
          invocations: 0,
        },
        {
          period_start: '2026-05-21',
          model: 'claude-sonnet-4',
          cost_usd: 4.5,
          tokens_in: 500000,
          tokens_in_cached: 0,
          tokens_out: 1000,
          requests: 25,
          messages_sent: 0,
          invocations: 0,
        },
      ]);

      const req = makeReq({ provider: 'anthropic', days: '30' });
      const res = makeRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        provider: 'anthropic',
        range: { from: '2026-04-22', to: '2026-05-22' },
      });
      expect(res.body.kpis).toEqual(
        expect.objectContaining({
          cost_usd_total: expect.any(Number),
          cost_usd_prev_period: expect.any(Number),
          delta_pct: expect.any(Number),
          tokens_total: expect.any(Number),
          requests_total: expect.any(Number),
        }),
      );
      expect(Array.isArray(res.body.by_day)).toBe(true);
      expect(Array.isArray(res.body.by_model)).toBe(true);
    });

    it('by_day ordenado por fecha asc, by_model por cost_usd desc', async () => {
      mocks.setRows([
        {
          period_start: '2026-05-20',
          model: 'claude-haiku-4-5',
          cost_usd: 1,
          tokens_in: 100,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
        {
          period_start: '2026-05-22',
          model: 'claude-opus-4-6',
          cost_usd: 100,
          tokens_in: 200,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
        {
          period_start: '2026-05-21',
          model: 'claude-sonnet-4',
          cost_usd: 50,
          tokens_in: 150,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);

      const req = makeReq({ provider: 'anthropic', days: '30' });
      const res = makeRes();
      await handler(req, res);

      const dates = res.body.by_day.map((d) => d.date);
      expect(dates).toEqual(['2026-05-20', '2026-05-21', '2026-05-22']);

      const models = res.body.by_model.map((m) => m.model);
      expect(models).toEqual(['claude-opus-4-6', 'claude-sonnet-4', 'claude-haiku-4-5']);
    });

    it('agrega tokens_in + tokens_in_cached + tokens_out en tokens_total', async () => {
      mocks.setRows([
        {
          period_start: '2026-05-22',
          model: 'm1',
          cost_usd: 0,
          tokens_in: 100,
          tokens_in_cached: 50,
          tokens_out: 25,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);

      const req = makeReq({ provider: 'meta', days: '30' });
      const res = makeRes();
      await handler(req, res);

      expect(res.body.kpis.tokens_total).toBe(175); // 100 + 50 + 25
    });

    it('setea Cache-Control: public, max-age=300', async () => {
      const req = makeReq({ provider: 'meta' });
      const res = makeRes();
      await handler(req, res);
      expect(res.headers['Cache-Control']).toMatch(/max-age=300/);
    });
  });

  /* ── (c) Wapify bypass (D2=a) ───────────────────────────────────────── */

  describe('(c) provider=wapify devuelve bypass D2=a', () => {
    it('responde 200 con note y arrays vacíos sin tocar Supabase', async () => {
      const req = makeReq({ provider: 'wapify', days: '30' });
      const res = makeRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        provider: 'wapify',
        range: { from: '2026-04-22', to: '2026-05-22' },
        kpis: {
          cost_usd_total: 0,
          cost_usd_prev_period: 0,
          delta_pct: 0,
          tokens_total: 0,
          requests_total: 0,
        },
        by_day: [],
        by_model: [],
        note: 'Wapify no incluido en v1',
      });
      // Verificación clave: NO se construyó cliente Supabase ni se hizo query.
      expect(mocks.createClient).not.toHaveBeenCalled();
      expect(mocks.calls.selects).toHaveLength(0);
    });
  });

  /* ── (d) Cálculo de delta_pct ───────────────────────────────────────── */

  describe('(d) cálculo de delta_pct', () => {
    it('positivo: curr=200, prev=100 → +100%', async () => {
      mocks.setRows([
        // Actual (period_start >= 2026-04-22)
        {
          period_start: '2026-05-22',
          model: null,
          cost_usd: 200,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
        // Anterior (period_start < 2026-04-22)
        {
          period_start: '2026-04-01',
          model: null,
          cost_usd: 100,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);

      const req = makeReq({ provider: 'meta', days: '30' });
      const res = makeRes();
      await handler(req, res);

      expect(res.body.kpis.cost_usd_total).toBe(200);
      expect(res.body.kpis.cost_usd_prev_period).toBe(100);
      expect(res.body.kpis.delta_pct).toBe(100);
    });

    it('caso del spec §4: 142.38 vs 98.50 → ~44.55%', async () => {
      mocks.setRows([
        {
          period_start: '2026-05-22',
          model: null,
          cost_usd: 142.38,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
        {
          period_start: '2026-04-01',
          model: null,
          cost_usd: 98.5,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);
      const req = makeReq({ provider: 'anthropic', days: '30' });
      const res = makeRes();
      await handler(req, res);
      // (142.38 - 98.50) / 98.50 * 100 = 44.55329... → 44.55 a 2 decimales
      expect(res.body.kpis.delta_pct).toBeCloseTo(44.55, 2);
    });

    it('prev=0 y curr=0 → 0 (sin div-by-zero)', async () => {
      mocks.setRows([]);
      const req = makeReq({ provider: 'meta', days: '30' });
      const res = makeRes();
      await handler(req, res);
      expect(res.body.kpis.delta_pct).toBe(0);
    });

    it('prev=0 y curr>0 → 100 (primer período con datos)', async () => {
      mocks.setRows([
        {
          period_start: '2026-05-22',
          model: null,
          cost_usd: 50,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);
      const req = makeReq({ provider: 'meta', days: '30' });
      const res = makeRes();
      await handler(req, res);
      expect(res.body.kpis.cost_usd_prev_period).toBe(0);
      expect(res.body.kpis.delta_pct).toBe(100);
    });

    it('negativo: curr=50, prev=100 → -50%', async () => {
      mocks.setRows([
        {
          period_start: '2026-05-22',
          model: null,
          cost_usd: 50,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
        {
          period_start: '2026-04-01',
          model: null,
          cost_usd: 100,
          tokens_in: 0,
          tokens_in_cached: 0,
          tokens_out: 0,
          requests: 0,
          messages_sent: 0,
          invocations: 0,
        },
      ]);
      const req = makeReq({ provider: 'meta', days: '30' });
      const res = makeRes();
      await handler(req, res);
      expect(res.body.kpis.delta_pct).toBe(-50);
    });
  });
});
