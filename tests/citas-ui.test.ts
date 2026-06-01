/**
 * tests/citas-ui.test.ts — BFF de lectura GET /api/citas-ui (agenda del dashboard).
 *
 * Invariantes que blinda:
 *   - Auth por Origin/Referer (NO Bearer): el browser del dashboard carga la
 *     agenda SIN token. Origen ajeno o ausente → 403.
 *   - SOLO GET (mutaciones siguen en /api/citas Bearer-gated): otros métodos → 405.
 *   - Shape { ok, total, page, page_size, citas } y filtros fecha_desde/hasta.
 *   - No-PII: la lista de columnas jamás pide nombre/teléfono/email.
 *
 * Mock de @supabase/supabase-js: builder stateful que registra columnas y filtros
 * y se resuelve vía `.then` (el handler hace `await query`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => {
  interface Cfg {
    rows: Array<Record<string, unknown>>;
    count: number;
    error: { message?: string } | null;
  }
  const fresh = (): Cfg => ({ rows: [], count: 0, error: null });
  let cfg: Cfg = fresh();
  const calls = {
    selectCols: [] as string[],
    filters: [] as Array<{ op: string; col: string; val: unknown }>,
    ranges: [] as Array<{ from: number; to: number }>,
  };

  function makeBuilder() {
    const b: Record<string, unknown> = {
      select(cols: string) { calls.selectCols.push(cols); return b; },
      order() { return b; },
      range(from: number, to: number) { calls.ranges.push({ from, to }); return b; },
      gte(col: string, val: unknown) { calls.filters.push({ op: 'gte', col, val }); return b; },
      lte(col: string, val: unknown) { calls.filters.push({ op: 'lte', col, val }); return b; },
      eq(col: string, val: unknown) { calls.filters.push({ op: 'eq', col, val }); return b; },
      ilike(col: string, val: unknown) { calls.filters.push({ op: 'ilike', col, val }); return b; },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: cfg.rows, error: cfg.error, count: cfg.count }).then(onF, onR);
      },
    };
    return b;
  }

  const client = { from() { return makeBuilder(); } };

  return {
    calls,
    setCfg: (c: Partial<Cfg>) => { cfg = { ...cfg, ...c }; },
    resetCfg: () => { cfg = fresh(); },
    createClient: vi.fn(() => client),
  };
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
  return r as { statusCode: number; body: any; headers: Record<string, string>; ended: boolean;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown; };
}

function makeReq({
  method = 'GET',
  query = {} as Record<string, string>,
  headers = {} as Record<string, string | undefined>,
} = {}) {
  const hdrs: Record<string, string | undefined> = { ...headers };
  for (const k of Object.keys(hdrs)) if (hdrs[k] === undefined) delete hdrs[k];
  return { method, query, headers: hdrs };
}

const DASH = 'https://giolens-dashboard.vercel.app';

describe('GET /api/citas-ui — BFF de agenda (Origin-gated, sin Bearer)', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.calls.selectCols.length = 0;
    mocks.calls.filters.length = 0;
    mocks.calls.ranges.length = 0;
    mocks.resetCfg();
    handler = (await import('../api/citas-ui.ts')).default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Método ────────────────────────────────────────────────────────────────
  it('OPTIONS → 204 (preflight CORS)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(204);
  });

  it('método != GET (POST) → 405, sin tocar DB', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toBe('method_not_allowed');
    expect(res.headers['Allow']).toBe('GET');
    expect(mocks.calls.selectCols).toHaveLength(0);
  });

  // ── Origin/Referer guard ────────────────────────────────────────────────--
  it('sin Origin ni Referer → 403 origin_forbidden', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('origin_forbidden');
    expect(mocks.calls.selectCols).toHaveLength(0);
  });

  it('Origin ajeno → 403', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: 'https://evil.example.com' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('un subdominio look-alike (giolens-dashboard.evil.com) → 403', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: 'https://giolens-dashboard.vercel.app.evil.com' } }), res);
    expect(res.statusCode).toBe(403);
  });

  // ── Caso central: agenda carga SIN Bearer ───────────────────────────────--
  it('Origin permitido + SIN Authorization → 200 (este es el fix del 401)', async () => {
    mocks.setCfg({ rows: [{ id: 8, fecha: '2026-06-01', hora: '12:00:00', estado: 'confirmada', paciente_hash: '7005225d0ee5a0b0', gcal_event_id: 'evt' }], count: 1 });
    const res = makeRes();
    await handler(makeReq({
      query: { fecha_desde: '2026-06-01', fecha_hasta: '2026-06-01', page_size: '100' },
      headers: { origin: DASH }, // nota: NO hay header Authorization
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.citas).toHaveLength(1);
    expect(res.body.citas[0].id).toBe(8);
    expect(res.body).toHaveProperty('total', 1);
    expect(res.body).toHaveProperty('page', 1);
    expect(res.body).toHaveProperty('page_size', 100);
  });

  it('Referer (sin Origin) del dashboard también pasa → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { referer: `${DASH}/index.html` }, query: { fecha_desde: '2026-06-01' } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('localhost (dev) pasa → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: 'http://localhost:3000' } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('preview branch deploy (giolens-dashboard-git-x-team.vercel.app) pasa → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: 'https://giolens-dashboard-git-main-ojos.vercel.app' } }), res);
    expect(res.statusCode).toBe(200);
  });

  // ── Filtros ──────────────────────────────────────────────────────────────
  it('traduce fecha_desde/fecha_hasta a gte/lte sobre `fecha`', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { fecha_desde: '2026-06-01', fecha_hasta: '2026-06-01' }, headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.calls.filters).toContainEqual({ op: 'gte', col: 'fecha', val: '2026-06-01' });
    expect(mocks.calls.filters).toContainEqual({ op: 'lte', col: 'fecha', val: '2026-06-01' });
  });

  it('page/page_size acotan el range (page 2, size 100 → 100..199)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { page: '2', page_size: '100' }, headers: { origin: DASH } }), res);
    expect(mocks.calls.ranges[0]).toEqual({ from: 100, to: 199 });
  });

  it('estado inválido se ignora (no se aplica eq)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { estado: 'borrame; DROP' }, headers: { origin: DASH } }), res);
    expect(mocks.calls.filters.some((f) => f.op === 'eq' && f.col === 'estado')).toBe(false);
  });

  it('optometrista escapa wildcards (%, _, \\) antes del ilike', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { optometrista: 'a%_\\b' }, headers: { origin: DASH } }), res);
    const f = mocks.calls.filters.find((x) => x.op === 'ilike');
    expect(f?.val).toBe('%a\\%\\_\\\\b%');
  });

  // ── Exposición acotada de PII (rebanada tarjeta enriquecida, migration 029) ──
  it('expone los campos de enriquecimiento (nombre/teléfono/producto/resumen) pero NUNCA email/firma/contact_id', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    // Tokens exactos (evita falsos positivos tipo "confirmacion" ⊃ "firma").
    const colTokens = mocks.calls.selectCols.join(',').split(/[\s,]+/).filter(Boolean);
    // Identificador técnico + enriquecimiento de la tarjeta (incl. resumen clínico, mig 031).
    for (const col of ['paciente_hash', 'nombre_paciente', 'telefono_paciente', 'producto_motivo', 'resumen_expediente']) {
      expect(colTokens).toContain(col);
    }
    // Email/firma/contact_id JAMÁS se exponen (blast radius de PII acotado al mínimo de la tarjeta).
    for (const forbidden of ['email', 'paciente_email', 'firma', 'firma_data_url', 'contact_id']) {
      expect(colTokens).not.toContain(forbidden);
    }
  });

  it('devuelve nombre_paciente/telefono_paciente/producto_motivo/resumen_expediente de las filas', async () => {
    mocks.setCfg({ rows: [{ id: 9, fecha: '2026-06-01', hora: '12:00:00', estado: 'confirmada', paciente_hash: 'h', nombre_paciente: 'Ana', telefono_paciente: '6641112233', producto_motivo: 'lentes de sol', resumen_expediente: 'busca lentes de sol, sin padecimiento' }], count: 1 });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { fecha_desde: '2026-06-01' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.citas[0].nombre_paciente).toBe('Ana');
    expect(res.body.citas[0].telefono_paciente).toBe('6641112233');
    expect(res.body.citas[0].producto_motivo).toBe('lentes de sol');
    expect(res.body.citas[0].resumen_expediente).toBe('busca lentes de sol, sin padecimiento');
  });

  // ── Degradación ──────────────────────────────────────────────────────────
  it('sin envs de Supabase → 500 service_unavailable (nunca crash)', async () => {
    delete process.env.SUPABASE_URL;
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('service_unavailable');
  });

  it('error de Supabase → 500 internal_error, sin filtrar el message crudo', async () => {
    mocks.setCfg({ error: { message: 'column secreta does not exist' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toMatch(/secreta/);
  });
});

describe('public/index.html · agenda cableada al BFF de lectura (no al endpoint Bearer)', () => {
  const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');

  it('las lecturas de la agenda (cargar + detalle) van a /api/citas-ui', () => {
    // El fix: las dos lecturas GET de la agenda usan el BFF Origin-gated.
    const lecturas = html.match(/await fetch\(`\/api\/citas-ui\?/g) || [];
    expect(lecturas.length).toBeGreaterThanOrEqual(2);
  });

  it('ya no quedan GET de la agenda contra el endpoint Bearer /api/citas?', () => {
    // Sólo deben quedar referencias a /api/citas? en las MUTACIONES (PUT/POST),
    // nunca como fetch GET de lectura (esas serían el 401 de regreso).
    expect(html).not.toMatch(/await fetch\(`\/api\/citas\?[^`]*`\)/);
  });

  it('el resumen_expediente (clínico) se renderiza SOLO si hay dato (condicional, sin undefined)', () => {
    // El detalle de cita muestra "Resumen de conversación" únicamente cuando el campo
    // viene con valor; null/vacío → no se renderiza la línea (back-compat citas viejas).
    expect(html).toMatch(/resumen=String\(c\.resumen_expediente\|\|''\)\.trim\(\)/);
    expect(html).toMatch(/resumen\?fila\('Resumen de conversación',esc\(resumen\)\):''/);
  });
});

describe('citas-core (path Bearer /api/citas) · NO expone resumen_expediente ni PII', () => {
  const core = readFileSync(resolve(process.cwd(), 'agents/_shared/citas/citas-core.ts'), 'utf8');
  // Aísla el array SELECT_COLS (columnas que el endpoint Bearer/programático devuelve).
  const selectColsBlock = (core.match(/const SELECT_COLS\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';

  it('SELECT_COLS del path Bearer NO incluye el resumen clínico ni la PII de la tarjeta', () => {
    for (const forbidden of ['resumen_expediente', 'nombre_paciente', 'telefono_paciente', 'producto_motivo', 'contact_id', 'email']) {
      expect(selectColsBlock).not.toContain(forbidden);
    }
  });

  it('ningún select(\'*\') sobre la tabla citas en el path Bearer (no expone columnas por accidente)', () => {
    expect(core).not.toMatch(/\.select\(\s*['"`]\*/);
  });
});
