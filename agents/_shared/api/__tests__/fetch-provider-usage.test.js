/**
 * GIOCORE Bloque 7 — tests del cron `api/cron/fetch-provider-usage.ts`.
 *
 * Estos son UNIT tests: mockeamos `@supabase/supabase-js` y el fetcher de Meta
 * con `vi.mock` para validar el control flow del handler sin tocar red ni DB.
 *
 * Tests de integración con DB real (insert + upsert + rollback) → fuera de
 * scope acá (sandbox sin red); deben correrse con `psql "$DATABASE_URL" -f ...`
 * — ver comando documentado al final de este archivo.
 *
 * Convención de Fase 1: archivo `.test.js` bajo `__tests__/`, importa el `.ts`
 * directamente (vitest transpila con esbuild).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ── Mocks hoisted (necesarios antes de que el módulo bajo test cargue) ─── */

const mocks = vi.hoisted(() => {
  // Tracker compartido entre tests para inspeccionar llamadas a Supabase.
  const calls = {
    rpc: [], // [{ name, args }]
    inserts: [], // [{ table, row }]
  };
  const supabaseClient = {
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: 1, error: null });
    },
    from(table) {
      return {
        insert(row) {
          calls.inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return {
    calls,
    createClient: vi.fn(() => supabaseClient),
    fetchMetaUsage: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('../../providers/meta', () => ({
  fetchMetaUsage: mocks.fetchMetaUsage,
}));

// El handler también referencia el módulo de types vía import-type-only —
// no necesita mock porque esbuild elimina los imports type-only.

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

function makeMetaRow(overrides = {}) {
  return {
    provider: 'meta',
    model: null,
    account_id: 'act_299921604429631',
    period_start: '2026-05-21',
    period_end: '2026-05-21',
    cost_usd: 12.34,
    requests: 100,
    invocations: 5000,
    raw_payload: { spend: '12.34' },
    ...overrides,
  };
}

/* ── Suite ──────────────────────────────────────────────────────────────── */

describe('api/cron/fetch-provider-usage.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    // Reset trackers
    mocks.calls.rpc.length = 0;
    mocks.calls.inserts.length = 0;
    mocks.fetchMetaUsage.mockReset();
    mocks.createClient.mockClear();

    // Envs por defecto (cada test puede sobreescribir)
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    // Fijar "ahora" para que `yesterday` sea determinista.
    // 2026-05-22 12:00:00 UTC → ayer = 2026-05-21.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/cron/fetch-provider-usage.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) devuelve 401 si no hay header Authorization', async () => {
    mocks.fetchMetaUsage.mockResolvedValue([makeMetaRow()]);

    const req = { headers: {} };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.ended).toBe(true);
    expect(mocks.fetchMetaUsage).not.toHaveBeenCalled();
    expect(mocks.calls.rpc).toHaveLength(0);
  });

  it('(b) devuelve 401 si el bearer es incorrecto', async () => {
    mocks.fetchMetaUsage.mockResolvedValue([makeMetaRow()]);

    const req = { headers: { authorization: 'Bearer wrong-secret' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.ended).toBe(true);
    expect(mocks.fetchMetaUsage).not.toHaveBeenCalled();
  });

  it('(c) devuelve 200 con el bearer correcto', async () => {
    mocks.fetchMetaUsage.mockResolvedValue([makeMetaRow()]);

    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      day: '2026-05-21',
    });
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('(d) llama al fetcher con la fecha de ayer (UTC)', async () => {
    mocks.fetchMetaUsage.mockResolvedValue([makeMetaRow()]);

    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    const res = makeRes();
    await handler(req, res);

    expect(mocks.fetchMetaUsage).toHaveBeenCalledTimes(1);
    const arg = mocks.fetchMetaUsage.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Date);
    // 2026-05-22 12:00 UTC menos 86_400_000 ms = 2026-05-21 12:00 UTC.
    expect(arg.toISOString().slice(0, 10)).toBe('2026-05-21');
  });

  it('(e) llama supabase.rpc("upsert_provider_usage", ...) N veces con los 15 params', async () => {
    const rows = [makeMetaRow({ account_id: 'act_1' }), makeMetaRow({ account_id: 'act_2' })];
    mocks.fetchMetaUsage.mockResolvedValue(rows);

    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    const res = makeRes();
    await handler(req, res);

    expect(mocks.calls.rpc).toHaveLength(2);
    for (const call of mocks.calls.rpc) {
      expect(call.name).toBe('upsert_provider_usage');
      // 15 params según migración 003
      expect(Object.keys(call.args)).toEqual(
        expect.arrayContaining([
          'p_provider',
          'p_model',
          'p_workspace_id',
          'p_account_id',
          'p_period_start',
          'p_period_end',
          'p_tokens_in',
          'p_tokens_in_cached',
          'p_tokens_out',
          'p_requests',
          'p_invocations',
          'p_bandwidth_gb',
          'p_messages_sent',
          'p_cost_usd',
          'p_raw_payload',
        ]),
      );
      expect(call.args.p_provider).toBe('meta');
      expect(call.args.p_period_start).toBe('2026-05-21');
    }
    expect(res.body.results[0]).toMatchObject({
      provider: 'meta',
      status: 'fulfilled',
      rows_upserted: 2,
    });
  });

  it('(f) si el fetcher rechaza, inserta en agent_decisions con shape real del schema', async () => {
    mocks.fetchMetaUsage.mockRejectedValue(new Error('Meta API unavailable'));

    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    const res = makeRes();
    await handler(req, res);

    // No se hicieron upserts.
    expect(mocks.calls.rpc).toHaveLength(0);

    // Se insertó UNA fila en agent_decisions.
    expect(mocks.calls.inserts).toHaveLength(1);
    const { table, row } = mocks.calls.inserts[0];
    expect(table).toBe('agent_decisions');

    // Schema real (NOT NULLs respetados, sin columnas inexistentes):
    expect(row.agent_name).toBe('cron_fetch_provider_usage');
    expect(row.decision_type).toBe('provider_usage_fetch_error');
    expect(row.proposed_action).toMatchObject({
      provider: 'meta',
      day: '2026-05-21',
      error_message: 'Meta API unavailable',
    });
    expect(typeof row.justification).toBe('string');
    expect(row.justification).toContain('meta');
    expect(row.evidence_refs).toMatchObject({
      provider: 'meta',
      error_message: 'Meta API unavailable',
    });
    expect(typeof row.severity).toBe('number');
    expect(row.status).toBe('auto_approved');

    // El response sigue siendo 200 (el cron es resiliente a fallos parciales).
    expect(res.statusCode).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      provider: 'meta',
      status: 'rejected',
      error: 'Meta API unavailable',
    });
  });

  it('NO incluye a Wapify en las tareas (D2=a, Wapify excluido de v1)', async () => {
    mocks.fetchMetaUsage.mockResolvedValue([makeMetaRow()]);

    const req = { headers: { authorization: 'Bearer test-cron-secret' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].provider).toBe('meta');
    // Confirmación negativa: ningún result.provider === 'wapify'
    expect(res.body.results.some((r) => r.provider === 'wapify')).toBe(false);
  });
});

/*
 * ── Test de integración con DB real (NO se corre acá) ──────────────────────
 * Sandbox sin red; correr a mano cuando se desbloquee:
 *
 *   psql "$DATABASE_URL" <<'SQL'
 *   BEGIN;
 *   -- Simular upsert idéntico al que hace el cron:
 *   SELECT upsert_provider_usage('meta', NULL, NULL, 'act_test', '2026-05-21',
 *     '2026-05-21', 0, 0, 0, 0, 0, 0, 0, 12.34, '{"test":true}'::jsonb);
 *   SELECT id, provider, cost_usd FROM provider_usage WHERE account_id='act_test';
 *   ROLLBACK;
 *   SQL
 */
