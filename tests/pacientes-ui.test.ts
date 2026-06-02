/**
 * tests/pacientes-ui.test.ts — BFF M1 · /api/pacientes-ui (búsqueda/lectura sobre contacts
 * + asegurar expediente). NO escribe en contacts (cache de Wapify).
 *
 * Invariantes:
 *   - Origin-gated (NO Bearer): origen ajeno/ausente → 403. Solo GET/POST/OPTIONS → 405.
 *   - ?q → búsqueda con has_expediente; ?contact_id → detalle; POST → asegurar expediente.
 *   - NUNCA inventa identidad: contacto no en contacts → 404 (no inserta).
 *   - NUNCA escribe en `contacts` (solo en `expedientes`, tagueado dashboard_alta).
 *   - PII (name/phone/email) jamás en logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface Cfg {
    contactsSearchRows: Array<Record<string, unknown>>;
    expedientesRows: Array<Record<string, unknown>>;   // thenable sobre expedientes (in/eq.order)
    contactDetail: Record<string, unknown> | null;     // maybeSingle sobre contacts
    expExistente: Record<string, unknown> | null;      // maybeSingle sobre expedientes (idempotencia)
    insertData: Record<string, unknown> | null;
    insertError: { code?: string } | null;
    error: { code?: string } | null;
  }
  const fresh = (): Cfg => ({
    contactsSearchRows: [{ contact_id: 'c1', name: 'Ana', phone: '6640000000', email: null }],
    expedientesRows: [],
    contactDetail: { contact_id: 'c1', name: 'Ana', phone: '6640000000', email: null },
    expExistente: null,
    insertData: { id: 100 },
    insertError: null,
    error: null,
  });
  let cfg: Cfg = fresh();
  const calls = { from: [] as string[], inserted: [] as Array<Record<string, unknown>>, selectCols: [] as string[], orFilters: [] as string[] };

  function makeBuilder(table: string) {
    let op: 'select' | 'insert' = 'select';
    const b: Record<string, unknown> = {
      select(cols?: string) { if (typeof cols === 'string') calls.selectCols.push(`${table}:${cols}`); return b; },
      insert(row: Record<string, unknown>) { op = 'insert'; calls.inserted.push({ __table: table, ...row }); return b; },
      or(expr: string) { calls.orFilters.push(expr); return b; },
      eq() { return b; },
      in() { return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      single() { return Promise.resolve({ data: cfg.insertData, error: cfg.insertError }); },
      maybeSingle() {
        if (table === 'contacts') return Promise.resolve({ data: cfg.contactDetail, error: cfg.error });
        return Promise.resolve({ data: cfg.expExistente, error: cfg.error });
      },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        void op;
        const rows = table === 'contacts' ? cfg.contactsSearchRows : cfg.expedientesRows;
        return Promise.resolve({ data: rows, error: cfg.error }).then(onF, onR);
      },
    };
    return b;
  }
  const client = { from(table: string) { calls.from.push(table); return makeBuilder(table); } };
  return {
    calls,
    setCfg: (c: Partial<Cfg>) => { cfg = { ...cfg, ...c }; },
    resetCfg: () => { cfg = fresh(); },
    createClient: vi.fn(() => client),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

const DASH = 'https://giolens-dashboard.vercel.app';
function makeRes() {
  const r: Record<string, unknown> = {
    statusCode: null, body: null, headers: {} as Record<string, string>, ended: false,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    setHeader(n: string, v: string) { (r.headers as Record<string, string>)[n] = v; return r; },
  };
  return r as { statusCode: number; body: any; headers: Record<string, string>;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown; };
}
function makeReq({ method = 'GET', query = {}, headers = {}, body = undefined as unknown } = {}) {
  return { method, query, headers, body };
}

describe('GET/POST /api/pacientes-ui — M1', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;
  beforeEach(async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.resetCfg();
    mocks.calls.from.length = 0;
    mocks.calls.inserted.length = 0;
    mocks.calls.selectCols.length = 0;
    mocks.calls.orFilters.length = 0;
    handler = (await import('../api/pacientes-ui.ts')).default;
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.SUPABASE_URL; });

  // ── Auth / método ──
  it('sin Origin → 403', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
  });
  it('método PUT → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(405);
  });
  it('OPTIONS → 204', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(204);
  });

  // ── Búsqueda ──
  it('?q → { ok, pacientes } con has_expediente', async () => {
    mocks.setCfg({
      contactsSearchRows: [{ contact_id: 'c1', name: 'Ana', phone: '111', email: null }, { contact_id: 'c2', name: 'Beto', phone: '222', email: null }],
      expedientesRows: [{ contact_id: 'c2' }],
    });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { q: 'a' } }), res);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.body.pacientes.map((p: any) => [p.contact_id, p.has_expediente]));
    expect(byId.c1).toBe(false);
    expect(byId.c2).toBe(true);
  });
  it('?q saneado contra inyección en .or()', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { q: "a,b(c)%_\\'" } }), res);
    expect(mocks.calls.orFilters[0]).not.toMatch(/[()\\'_]/);
  });
  it('sin q ni contact_id → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('q_o_contact_id_requerido');
  });

  // ── Detalle ──
  it('?contact_id → { ok, paciente, expedientes }', async () => {
    mocks.setCfg({ contactDetail: { contact_id: 'c1', name: 'Ana', phone: '111', email: null }, expedientesRows: [{ id: 9, fecha_examen: '2026-05-01' }] });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.paciente.contact_id).toBe('c1');
    expect(res.body.expedientes).toHaveLength(1);
  });
  it('?contact_id inexistente → 404', async () => {
    mocks.setCfg({ contactDetail: null });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('paciente_no_encontrado');
  });

  // ── POST asegurar expediente ──
  it('POST sin contact_id → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('contact_id_requerido');
  });
  it('POST contacto NO en contacts → 404 paciente_no_en_sistema, NO inserta (no inventa walk-in)', async () => {
    mocks.setCfg({ contactDetail: null });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { contact_id: 'ghost' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('paciente_no_en_sistema');
    expect(mocks.calls.inserted).toHaveLength(0);
  });
  it('POST contacto con expediente existente → 200 created:false (idempotente)', async () => {
    mocks.setCfg({ contactDetail: { contact_id: 'c1', name: 'Ana', phone: '1', email: null }, expExistente: { id: 55 } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.expediente_id).toBe(55);
    expect(mocks.calls.inserted).toHaveLength(0);
  });
  it('POST contacto sin expediente → 201 created:true, expediente TAGUEADO dashboard_alta', async () => {
    mocks.setCfg({ contactDetail: { contact_id: 'c1', name: 'Ana', phone: '1', email: null }, expExistente: null, insertData: { id: 101 } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.created).toBe(true);
    expect(mocks.calls.inserted).toHaveLength(1);
    const row = mocks.calls.inserted[0];
    expect(row.__table).toBe('expedientes');     // NUNCA escribe en contacts
    expect(row.capturado_desde).toBe('dashboard_alta');
    expect(row.contact_id).toBe('c1');
    expect(row.paciente_nombre).toBe('Ana');
  });
  it('NUNCA inserta en la tabla contacts (es cache de Wapify)', async () => {
    mocks.setCfg({ contactDetail: { contact_id: 'c1', name: 'Ana', phone: '1', email: null }, expExistente: null });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { contact_id: 'c1' } }), res);
    expect(mocks.calls.inserted.every((r) => r.__table !== 'contacts')).toBe(true);
  });

  // ── Privacidad ──
  it('PII (nombre/teléfono) NUNCA se loguea', async () => {
    const NOMBRE = 'NombreSensible_XYZ';
    const TEL = 'TEL_6649999999';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.setCfg({ contactDetail: { contact_id: 'c1', name: NOMBRE, phone: TEL, email: null }, expExistente: null, insertError: { code: '23505' } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { contact_id: 'c1' } }), res);
    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(allLogs).not.toContain(NOMBRE);
    expect(allLogs).not.toContain(TEL);
  });
});
