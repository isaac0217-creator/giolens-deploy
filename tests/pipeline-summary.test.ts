/**
 * tests/pipeline-summary.test.ts — fix "CRM en cero".
 *
 * Cubre el doble fallo diagnosticado:
 *   1. Latencia/rate-limit: bajo el fan-out (5 pipelines × metrics+journey), Wapify
 *      429-ea las paginaciones del pipeline grande → wapGet ANTES devolvía null y el
 *      paginador hacía `break` → TRUNCABA/CEROABA en silencio.
 *   2. Render: el front pintaba esos ceros como si fueran reales.
 *
 * Aquí se verifica la capa BACKEND:
 *   - parser con la forma real de opportunities → métricas reales (no cero),
 *   - wapGet LANZA en 429-agotado / !ok / timeout → nunca cero falso,
 *   - snapshot fresco en app_config → se sirve sin pegarle a Wapify,
 *   - fallo en vivo + snapshot previo → se sirve `stale:true` (no cero/no error),
 *   - fallo en vivo SIN snapshot → propaga error (handler 500), no 200-con-ceros,
 *   - journey y all=1.
 *
 * Mocks: @supabase/supabase-js (cache app_config, store en Map) + global.fetch (Wapify).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Supabase mock (cache app_config) ───────────────────────────────────────
const mocks = vi.hoisted(() => {
  const store = new Map<string, { value: unknown; updated_at: string }>();
  const upserts: string[] = [];
  function makeBuilder() {
    let key: string | null = null;
    const b: Record<string, unknown> = {
      from() { return b; },
      select() { return b; },
      eq(col: string, val: string) { if (col === 'key') key = val; return b; },
      maybeSingle() {
        const row = key ? store.get(key) : null;
        return Promise.resolve({ data: row ? { value: row.value, updated_at: row.updated_at } : null, error: null });
      },
      upsert(obj: { key: string; value: unknown; updated_at: string }) {
        store.set(obj.key, { value: obj.value, updated_at: obj.updated_at });
        upserts.push(obj.key);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return b;
  }
  const client = { from() { return makeBuilder(); } };
  return { store, upserts, createClient: vi.fn(() => client) };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

// ─── fetch stub (Wapify) ────────────────────────────────────────────────────
let fetchImpl: (url: string) => { status: number; ok: boolean; json: () => Promise<unknown> };
let fetchUrls: string[] = [];
function ok(body: unknown) { return { status: 200, ok: true, json: async () => body }; }
function http(status: number) { return { status, ok: false, json: async () => ({}) }; }

// Genera un dataset de opportunities (paginado por el handler) con etapas variadas.
function makeOpps(n: number) {
  const out: unknown[] = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    // 70% activos viejos (estancados), algunos won/lost
    let stage = 'COTIZADO';
    if (i % 50 === 0) stage = 'VENTA CONFIRMADA';      // won
    else if (i % 77 === 0) stage = 'LEAD PERDIDO';      // lost
    else if (i % 3 === 0) stage = 'INT2 SEGUIMIENTO';
    out.push({ stage: { id: 's-' + stage, name: stage }, updated_at: new Date(now - 72 * 3600_000).toISOString() });
  }
  return out;
}
// fetch que pagina un dataset y devuelve stages
function pagedFetch(opps: unknown[]) {
  return (url: string) => {
    if (url.includes('/stages')) {
      return ok({ data: [
        { id: 's-COTIZADO', name: 'COTIZADO' },
        { id: 's-INT2 SEGUIMIENTO', name: 'INT2 SEGUIMIENTO' },
        { id: 's-VENTA CONFIRMADA', name: 'VENTA CONFIRMADA' },
        { id: 's-LEAD PERDIDO', name: 'LEAD PERDIDO' },
      ] });
    }
    const m = /offset=(\d+)&limit=(\d+)/.exec(url);
    const off = m ? parseInt(m[1], 10) : 0, lim = m ? parseInt(m[2], 10) : 100;
    return ok({ data: opps.slice(off, off + lim) });
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.WAPIFY_TOKEN = 'tok';
  mocks.store.clear();
  mocks.upserts.length = 0;
  fetchUrls = [];
  fetchImpl = pagedFetch(makeOpps(250));
  global.fetch = vi.fn((url: unknown) => { fetchUrls.push(String(url)); return fetchImpl(String(url)) as unknown as Response; }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); delete (global as { fetch?: unknown }).fetch; });

function makeRes() {
  const r: Record<string, unknown> = {
    statusCode: 0, body: null as unknown,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    end() { return r; },
    setHeader() { return r; },
  };
  return r as { statusCode: number; body: any; status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(...a: unknown[]): unknown };
}
const req = (query: Record<string, string>) => ({ method: 'GET', query });
async function load() { return (await import('../api/pipeline-summary.js')).default as (q: unknown, r: unknown) => Promise<unknown>; }
const oppCalls = () => fetchUrls.filter(u => u.includes('/opportunities')).length;

describe('GET /api/pipeline-summary — fix CRM en cero', () => {
  it('metrics: parser con forma real → métricas REALES, no cero; cachea el snapshot', async () => {
    const h = await load();
    const res = makeRes();
    await h(req({ pipeline_id: '216977', mode: 'metrics' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(250);
    expect(res.body.active).toBeGreaterThan(0);
    expect(res.body.won).toBeGreaterThan(0);
    expect(res.body.stagnantTotal).toBeGreaterThan(0);   // NO cero
    expect(res.body._cache).toBe('live');
    expect(mocks.upserts).toContain('ps_cache:216977:metrics');   // se guardó snapshot
  });

  it('429 persistente SIN caché → LANZA → handler 500 (nunca 200-con-ceros)', async () => {
    fetchImpl = () => http(429);
    const h = await load();
    const res = makeRes();
    await h(req({ pipeline_id: '216977', mode: 'metrics' }), res);
    // CLAVE: no devuelve 200 con total:0; reporta error → el front muestra "sin conexión".
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBeTruthy();
    expect(res.body.total).toBeUndefined();
  });

  it('fallo en vivo CON snapshot previo → sirve stale:true (no cero, no error)', async () => {
    // Sembrar snapshot reciente-pero-no-fresco (> TTL) para forzar recompute→fallo→stale.
    mocks.store.set('ps_cache:216977:metrics', {
      value: { pipeline_id: '216977', total: 4930, active: 4929, stagnantTotal: 4623, won: 0, lost: 1, convRate: 0 },
      updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),  // 20 min → stale
    });
    fetchImpl = () => http(429);   // recompute falla
    const h = await load();
    const res = makeRes();
    await h(req({ pipeline_id: '216977', mode: 'metrics' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(4930);       // datos reales del snapshot, NO cero
    expect(res.body.stale).toBe(true);
    expect(res.body._cache).toBe('stale');
  });

  it('snapshot FRESCO (<TTL) → se sirve sin pegarle a Wapify', async () => {
    mocks.store.set('ps_cache:216977:metrics', {
      value: { pipeline_id: '216977', total: 4930, active: 4929, stagnantTotal: 4623 },
      updated_at: new Date(Date.now() - 60 * 1000).toISOString(),  // 1 min → fresco
    });
    const h = await load();
    const res = makeRes();
    await h(req({ pipeline_id: '216977', mode: 'metrics' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(4930);
    expect(res.body._cache).toBe('fresh');
    expect(oppCalls()).toBe(0);              // cero llamadas a Wapify
  });

  it('journey: by_phase + funnel_rates con valores reales', async () => {
    const h = await load();
    const res = makeRes();
    await h(req({ pipeline_id: '216977', mode: 'journey' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(250);
    expect(res.body.by_phase).toBeTruthy();
    const bp = res.body.by_phase;
    expect(bp.int1 + bp.int2 + bp.int3 + bp.closing + bp.won + bp.lost).toBeGreaterThan(0);
    expect(res.body.funnel_rates).toBeTruthy();
  });

  it('all=1 metrics: 5 pipelines; uno que falla → {error}, no cero, sin tumbar a los demás', async () => {
    fetchImpl = (url) => {
      if (url.includes('pipelines/216977/')) return http(429);  // el grande falla
      return pagedFetch(makeOpps(120))(url);
    };
    const h = await load();
    const res = makeRes();
    await h(req({ all: '1', mode: 'metrics' }), res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(5);
    const failed = res.body.data.find((d: any) => d.pipeline_id === '216977');
    expect(failed.error).toBeTruthy();      // error explícito, NO total:0
    expect(failed.total).toBeUndefined();
    const okOne = res.body.data.find((d: any) => d.pipeline_id !== '216977' && !d.error);
    expect(okOne.total).toBe(120);          // los demás siguen con datos reales
  });
});
