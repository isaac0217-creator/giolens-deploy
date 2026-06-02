/**
 * tests/expediente-ui.test.ts — BFF M2 · GET /api/expediente-ui (historial del paciente).
 *
 * Invariantes:
 *   - Origin-gated (NO Bearer): origen ajeno/ausente → 403. Solo GET/OPTIONS → 405.
 *   - Une por contact_id: paciente (contacts) + expedientes + citas + atenciones.
 *   - `?paciente_id` es alias de `?contact_id`.
 *   - atenciones BEST-EFFORT: si la tabla no existe (42P01) → [] + flag, sin romper.
 *   - Sin citas/expedientes → listas vacías, NO error.
 *   - PII (name/phone/nota/observaciones) jamás en logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface Cfg {
    paciente: Record<string, unknown> | null;
    pacienteError: { code?: string } | null;
    expedientes: Array<Record<string, unknown>>;
    expedientesError: { code?: string } | null;
    citas: Array<Record<string, unknown>>;
    citasError: { code?: string } | null;
    atenciones: Array<Record<string, unknown>>;
    atencionesError: { code?: string } | null;
  }
  const fresh = (): Cfg => ({
    paciente: { contact_id: 'c1', name: 'Ana', phone: '111', email: null },
    pacienteError: null,
    expedientes: [{ id: 1, fecha_examen: '2026-05-01' }],
    expedientesError: null,
    citas: [{ id: 7, fecha: '2026-05-10', hora: '12:00' }],
    citasError: null,
    atenciones: [{ id: 3, canal: 'whatsapp', tipo: 'consulta', estado: 'abierta' }],
    atencionesError: null,
  });
  let cfg: Cfg = fresh();
  const calls = { from: [] as string[] };

  function makeBuilder(table: string) {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: cfg.paciente, error: cfg.pacienteError }); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        let payload: { data: unknown[]; error: unknown };
        if (table === 'expedientes') payload = { data: cfg.expedientes, error: cfg.expedientesError };
        else if (table === 'citas') payload = { data: cfg.citas, error: cfg.citasError };
        else if (table === 'atenciones') payload = { data: cfg.atenciones, error: cfg.atencionesError };
        else payload = { data: [], error: null };
        return Promise.resolve(payload).then(onF, onR);
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
function makeReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

describe('GET /api/expediente-ui — M2 historial del paciente', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;
  beforeEach(async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.resetCfg();
    mocks.calls.from.length = 0;
    handler = (await import('../api/expediente-ui.ts')).default;
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.SUPABASE_URL; });

  it('sin Origin → 403', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
  });
  it('método POST → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(405);
  });
  it('OPTIONS → 204', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(204);
  });

  it('sin contact_id ni paciente_id → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('contact_id_requerido');
  });

  it('?contact_id → { ok, paciente, expedientes, citas, atenciones }', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.paciente.contact_id).toBe('c1');
    expect(res.body.expedientes).toHaveLength(1);
    expect(res.body.citas).toHaveLength(1);
    expect(res.body.atenciones).toHaveLength(1);
    expect(res.body.atenciones_disponible).toBe(true);
  });

  it('?paciente_id es alias de contact_id', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { paciente_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.paciente.contact_id).toBe('c1');
  });

  it('paciente no en contacts → paciente:null pero historial igual se devuelve (no 404)', async () => {
    mocks.setCfg({ paciente: null });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'huerfano' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.paciente).toBeNull();
    expect(res.body.citas).toHaveLength(1);
  });

  it('sin citas ni expedientes → listas vacías, NO error', async () => {
    mocks.setCfg({ expedientes: [], citas: [], atenciones: [] });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.expedientes).toEqual([]);
    expect(res.body.citas).toEqual([]);
  });

  it('atenciones tabla inexistente (42P01) → [] + atenciones_disponible:false, sin romper', async () => {
    mocks.setCfg({ atencionesError: { code: '42P01' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.atenciones).toEqual([]);
    expect(res.body.atenciones_disponible).toBe(false);
    // El historial de citas/expedientes NO se rompe por la falta de atenciones.
    expect(res.body.citas).toHaveLength(1);
  });

  it('error en expedientes → 500 internal_error', async () => {
    mocks.setCfg({ expedientesError: { code: '42501' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('PII (nombre/teléfono/nota) NUNCA se loguea', async () => {
    const NOMBRE = 'PacienteSecreto_XYZ';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Forzamos el path de error de citas para ejercer console.error.
    mocks.setCfg({ paciente: { contact_id: 'c1', name: NOMBRE, phone: '6649999999', email: null }, citasError: { code: '42P01' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { contact_id: 'c1' } }), res);
    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(allLogs).not.toContain(NOMBRE);
    expect(allLogs).not.toContain('6649999999');
  });
});
