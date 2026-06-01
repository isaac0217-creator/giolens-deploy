/**
 * tests/atenciones-ui.test.ts — BFF M4 Servicio al Cliente · /api/atenciones-ui.
 *
 * Invariantes que blinda:
 *   - Auth por Origin/Referer (NO Bearer): origen ajeno/ausente → 403.
 *   - Solo GET/POST/OPTIONS: otro método → 405.
 *   - GET list: shape { ok, total, page, page_size, atenciones } + filtros estado/contact_id.
 *   - POST crear: valida canal/tipo, default estado='abierta', valida contacto si viene.
 *   - POST estado: {id,estado} → update; id inexistente → 404; estado inválido → 400.
 *   - Privacidad: `nota` (PII potencial) NUNCA se loguea.
 *
 * Mock @supabase/supabase-js: builder stateful que distingue tabla (atenciones|contacts)
 * y operación (select-list thenable | insert.single | update.maybeSingle | contacts check).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface Cfg {
    listRows: Array<Record<string, unknown>>;
    listCount: number;
    listError: { code?: string } | null;
    insertData: Record<string, unknown> | null;
    insertError: { code?: string } | null;
    updateData: Record<string, unknown> | null;
    updateError: { code?: string } | null;
    contactExists: boolean;        // resultado del lookup en contacts
    contactError: { code?: string } | null;
  }
  const fresh = (): Cfg => ({
    listRows: [], listCount: 0, listError: null,
    insertData: { id: 1 }, insertError: null,
    updateData: { id: 1, estado: 'cerrada' }, updateError: null,
    contactExists: true, contactError: null,
  });
  let cfg: Cfg = fresh();
  const calls = {
    from: [] as string[],
    selectCols: [] as string[],
    filters: [] as Array<{ op: string; col: string; val: unknown }>,
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
  };

  function makeBuilder(table: string) {
    let op: 'select' | 'insert' | 'update' = 'select';
    let insertedRow: Record<string, unknown> = {};
    let updatePatch: Record<string, unknown> = {};

    const resolveSingle = () => {
      if (op === 'insert') return { data: cfg.insertData, error: cfg.insertError };
      if (op === 'update') return { data: cfg.updateData, error: cfg.updateError };
      // select.maybeSingle sobre contacts (lookup de existencia)
      if (table === 'contacts') return { data: cfg.contactExists ? { id: 1 } : null, error: cfg.contactError };
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {
      select(cols?: string) { if (typeof cols === 'string') calls.selectCols.push(cols); return b; },
      insert(row: Record<string, unknown>) { op = 'insert'; insertedRow = row; calls.inserted.push(row); return b; },
      update(patch: Record<string, unknown>) { op = 'update'; updatePatch = patch; calls.updated.push(patch); return b; },
      order() { return b; },
      range() { return b; },
      eq(col: string, val: unknown) { calls.filters.push({ op: 'eq', col, val }); return b; },
      limit() { return b; },
      single() { return Promise.resolve(resolveSingle()); },
      maybeSingle() { return Promise.resolve(resolveSingle()); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        // GET list (thenable): solo sobre atenciones
        return Promise.resolve({ data: cfg.listRows, error: cfg.listError, count: cfg.listCount }).then(onF, onR);
      },
    };
    void insertedRow; void updatePatch;
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

describe('GET/POST /api/atenciones-ui — M4 servicio al cliente', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.resetCfg();
    mocks.calls.from.length = 0;
    mocks.calls.selectCols.length = 0;
    mocks.calls.filters.length = 0;
    mocks.calls.inserted.length = 0;
    mocks.calls.updated.length = 0;
    handler = (await import('../api/atenciones-ui.ts')).default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SUPABASE_URL;
  });

  // ── Auth / método ──────────────────────────────────────────────────────────
  it('sin Origin/Referer → 403', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('origin_forbidden');
  });

  it('Origin ajeno → 403', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: 'https://evil.example.com' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('método no soportado (PUT) → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(405);
  });

  it('OPTIONS → 204 (preflight)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(204);
  });

  // ── GET list ────────────────────────────────────────────────────────────────
  it('GET devuelve shape { ok, total, page, page_size, atenciones }', async () => {
    mocks.setCfg({ listRows: [{ id: 1, canal: 'whatsapp', tipo: 'consulta', estado: 'abierta' }], listCount: 1 });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.atenciones).toHaveLength(1);
    expect(res.body.page).toBe(1);
  });

  it('GET ?estado=abierta filtra por estado', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { estado: 'abierta' } }), res);
    expect(mocks.calls.filters).toContainEqual({ op: 'eq', col: 'estado', val: 'abierta' });
  });

  it('GET ?estado=basura NO filtra (estado inválido ignorado)', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { estado: 'basura' } }), res);
    expect(mocks.calls.filters.find((f) => f.col === 'estado')).toBeUndefined();
  });

  it('GET ?contact_id=... filtra por contacto (historial)', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c-99' } }), res);
    expect(mocks.calls.filters).toContainEqual({ op: 'eq', col: 'contact_id', val: 'c-99' });
  });

  it('GET error de Supabase → 500 internal_error, sin filtrar el message crudo', async () => {
    mocks.setCfg({ listError: { code: '42P01' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  // ── POST crear ────────────────────────────────────────────────────────────--
  it('POST crear válido → 201 { ok, id }, estado default abierta', async () => {
    mocks.setCfg({ insertData: { id: 77 } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'whatsapp', tipo: 'consulta', nota: 'pregunta por lentes' } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe(77);
    expect(mocks.calls.inserted[0].estado).toBe('abierta');
    expect(mocks.calls.inserted[0].canal).toBe('whatsapp');
  });

  it('POST sin canal → 400 canal_requerido', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { tipo: 'consulta' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('canal_requerido');
  });

  it('POST sin tipo → 400 tipo_requerido', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'llamada' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('tipo_requerido');
  });

  it('POST body inválido (no objeto) → 400 invalid_body', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: 'no-json' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('POST con contact_id inexistente → 400 contacto_no_encontrado (no inserta)', async () => {
    mocks.setCfg({ contactExists: false });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'whatsapp', tipo: 'queja', contact_id: 'c-x' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('contacto_no_encontrado');
    expect(mocks.calls.inserted).toHaveLength(0);
  });

  it('POST con contact_id existente → 201, persiste contact_id', async () => {
    mocks.setCfg({ contactExists: true, insertData: { id: 5 } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'whatsapp', tipo: 'seguimiento', contact_id: 'c-ok' } }), res);
    expect(res.statusCode).toBe(201);
    expect(mocks.calls.inserted[0].contact_id).toBe('c-ok');
  });

  it('POST sanea nota larga (>2000) y canal con control chars', async () => {
    mocks.setCfg({ insertData: { id: 9 } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'what\tsapp', tipo: 'consulta', nota: 'a'.repeat(5000) } }), res);
    expect(res.statusCode).toBe(201);
    expect(mocks.calls.inserted[0].canal).toBe('what sapp');
    expect(String(mocks.calls.inserted[0].nota).length).toBe(2000);
  });

  // ── POST cambio de estado ─────────────────────────────────────────────────--
  it('POST {id, estado:cerrada} → 200 cierra', async () => {
    mocks.setCfg({ updateData: { id: 3, estado: 'cerrada' } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { id: 3, estado: 'cerrada' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe('cerrada');
    expect(mocks.calls.updated[0].estado).toBe('cerrada');
  });

  it('POST {id, estado:basura} → 400 estado_invalido', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { id: 3, estado: 'basura' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('estado_invalido');
  });

  it('POST {id inexistente, estado} → 404 atencion_no_encontrada', async () => {
    mocks.setCfg({ updateData: null });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { id: 999, estado: 'cerrada' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('atencion_no_encontrada');
  });

  it('POST {id:0} → 400 id_invalido', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { id: 0, estado: 'cerrada' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('id_invalido');
  });

  // ── Privacidad ──────────────────────────────────────────────────────────────
  it('la nota (PII potencial) NUNCA se loguea', async () => {
    const SENTINEL = 'DATO_SENSIBLE_DEL_PACIENTE_XYZ';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Forzamos también el path de error de insert para cubrir el console.error.
    mocks.setCfg({ insertError: { code: '23505' } });
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH }, body: { canal: 'whatsapp', tipo: 'queja', nota: SENTINEL } }), res);
    const allLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(allLogs).not.toContain(SENTINEL);
  });
});
