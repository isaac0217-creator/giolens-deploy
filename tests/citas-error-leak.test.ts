/**
 * Frente G · Hardening · Regresión info-leak en api/citas.ts (S13-F2)
 *
 * Vector: un error de Postgres NO-23505 (relación inexistente, conexión caída,
 * etc.) llegaba al cliente como `error: error.message` crudo en el 500 — fuga de
 * detalle interno (nombres de tabla/columna, estructura de la query). Ahora TODA
 * respuesta 500 devuelve `error: 'internal_error'` genérico, y el detalle queda
 * SOLO en `console.error` server-side.
 *
 * Estos tests blindan la invariante en los 3 caminos (POST insert, GET list,
 * PUT update): el body del 500 debe ser exactamente `internal_error` y NUNCA
 * debe contener el texto crudo del mensaje de Postgres (sentinel).
 *
 * Mock @supabase/supabase-js con builder que distingue la operación
 * (insert/update/select.single/list-thenable) para resolver el error correcto.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Sentinel: texto que SOLO existiría en un mensaje crudo de Postgres filtrado.
const PG_LEAK_SENTINEL = 'RAW_PG_LEAK_relation_citas_col_internal_xyz';

const mocks = vi.hoisted(() => {
  interface Cfg {
    // POST: insert(...).select(...).single()
    insertData?: unknown;
    insertError?: { code?: string; message?: string };
    // GET: select(...).order().order().range()  (thenable)
    listData?: unknown[];
    listError?: { code?: string; message?: string };
    count?: number;
    // PUT existing fetch: select(...).eq().single()  (sin insert/update)
    existingData?: unknown;
    // PUT: update(...).eq().select(...).single()
    updateData?: unknown;
    updateError?: { code?: string; message?: string };
  }
  let cfg: Cfg = {};
  const setCfg = (c: Cfg) => { cfg = c; };

  const makeBuilder = () => {
    let op: 'select' | 'insert' | 'update' = 'select';
    const b: Record<string, unknown> = {
      insert(_row: unknown) { op = 'insert'; return b; },
      update(_patch: unknown) { op = 'update'; return b; },
      select(_cols?: string, _opts?: unknown) { return b; },
      eq(_col: string, _val: unknown) { return b; },
      order(_col: string, _opts?: unknown) { return b; },
      range(_from: number, _to: number) { return b; },
      gte(_col: string, _val: unknown) { return b; },
      lte(_col: string, _val: unknown) { return b; },
      ilike(_col: string, _val: unknown) { return b; },
      single() {
        if (op === 'insert') {
          if (cfg.insertError) return Promise.resolve({ data: null, error: cfg.insertError });
          return Promise.resolve({ data: cfg.insertData ?? null, error: null });
        }
        if (op === 'update') {
          if (cfg.updateError) return Promise.resolve({ data: null, error: cfg.updateError });
          return Promise.resolve({ data: cfg.updateData ?? null, error: null });
        }
        // PUT existing-fetch (select.single sin insert/update)
        return Promise.resolve({ data: cfg.existingData ?? null, error: null });
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        if (cfg.listError) {
          return Promise.resolve({ data: null, error: cfg.listError, count: null }).then(res, rej);
        }
        return Promise.resolve({ data: cfg.listData ?? [], error: null, count: cfg.count ?? 0 }).then(res, rej);
      },
      catch(rej: (e: unknown) => unknown) {
        return (b.then as (r: undefined, j: unknown) => unknown)(undefined, rej);
      },
    };
    return b;
  };

  const supabaseClient = { from(_table: string) { return makeBuilder(); } };

  return { setCfg, createClient: vi.fn(() => supabaseClient) };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

function makeRes() {
  const r: Record<string, unknown> = {
    statusCode: null, body: null, headers: {} as Record<string, string>, ended: false,
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
    end() { r.ended = true; return r; },
    setHeader(name: string, value: string) { (r.headers as Record<string, string>)[name] = value; return r; },
  };
  return r as {
    statusCode: number; body: any; headers: Record<string, string>; ended: boolean;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown;
  };
}

function makeReq({
  method = 'GET',
  headers = {} as Record<string, string | undefined>,
  query = {} as Record<string, unknown>,
  body = undefined as unknown,
} = {}) {
  const hdrs: Record<string, string | undefined> = {
    authorization: `Bearer ${process.env.CRON_SECRET}`,
    origin: 'https://giolens-dashboard.vercel.app',
    ...headers,
  };
  for (const k of Object.keys(hdrs)) if (hdrs[k] === undefined) delete hdrs[k];
  return { method, headers: hdrs, query, body };
}

describe('api/citas.ts · regresión info-leak (500 → internal_error, sin detalle Postgres)', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test_cron_secret_citas';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.setCfg({});
    // Silenciar el console.error server-side (esperado) y poder verificar que SÍ se loggea.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handler = (await import('../api/citas.ts')).default;
  });

  // ─── POST insert ────────────────────────────────────────────────────────
  it('POST: error no-23505 en INSERT → 500 internal_error, sin texto crudo de Postgres', async () => {
    mocks.setCfg({ insertError: { code: '42P01', message: `relation does not exist :: ${PG_LEAK_SENTINEL}` } });
    const res = makeRes();
    await handler(
      makeReq({
        method: 'POST',
        body: { fecha: '2026-06-10', hora: '10:30', paciente_hash: 'abcdef0123456789', optometrista: 'Dra. Prueba' },
      }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain(PG_LEAK_SENTINEL);
  });

  // ─── GET list ─────────────────────────────────────────────────────────────
  it('GET: error en la query → 500 internal_error, sin texto crudo de Postgres', async () => {
    mocks.setCfg({ listError: { code: '42P01', message: `query failed :: ${PG_LEAK_SENTINEL}` } });
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: {} }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain(PG_LEAK_SENTINEL);
  });

  // ─── PUT update ───────────────────────────────────────────────────────────
  it('PUT: error no-23505 en UPDATE → 500 internal_error, sin texto crudo de Postgres', async () => {
    // existing fetch OK (optometrista presente); update falla. body sin `estado`
    // → no dispara el guard G-9, llega al UPDATE.
    mocks.setCfg({
      existingData: { gcal_event_id: null, estado: 'agendada', optometrista: 'Dra. Prueba', paciente_hash: 'abcdef0123456789' },
      updateError: { code: '08006', message: `connection failure :: ${PG_LEAK_SENTINEL}` },
    });
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '42' }, body: { notas: 'actualizar notas' } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain(PG_LEAK_SENTINEL);
  });

  // ─── server-side log preservado ───────────────────────────────────────────
  it('el detalle del error se preserva en console.error server-side (no se pierde)', async () => {
    mocks.setCfg({ listError: { code: '42P01', message: `query failed :: ${PG_LEAK_SENTINEL}` } });
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: {} }), res);
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain(PG_LEAK_SENTINEL);
  });

  // ─── el 23505 (slot ocupado) NO se confunde con internal_error ──────────────
  it('POST: 23505 slot_unique sigue devolviendo 409 slot_ocupado (no internal_error)', async () => {
    mocks.setCfg({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "idx_citas_slot_unique"' } });
    const res = makeRes();
    await handler(
      makeReq({
        method: 'POST',
        body: { fecha: '2026-06-10', hora: '10:30', paciente_hash: 'abcdef0123456789', optometrista: 'Dra. Prueba' },
      }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('slot_ocupado');
  });
});
