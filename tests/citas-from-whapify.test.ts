/**
 * tests/citas-from-whapify.test.ts — W2 · Rama B · endpoint POST /api/citas/from-whapify.
 *
 * Estrategia de mocks (mismo patrón que tests/cron-pull-gcal.test.ts):
 *   - @supabase/supabase-js: builder fake stateful. Soporta el pre-SELECT de
 *     idempotencia (.eq().neq().limit().maybeSingle()), el INSERT (.insert()
 *     .select().single()) y el UPDATE (.update().eq()).
 *   - global.fetch: dispatch por URL → token OAuth + POST de evento. Ejerce el
 *     cliente REAL gcal.ts (firma JWT con clave RSA generada en test).
 *   - Reloj: vi.setSystemTime(AHORA) (solo Date) para determinismo del resolver.
 *     AHORA = 2026-05-26 18:00Z = mar 2026-05-26 11:00 Tijuana (PDT).
 *
 * Cobertura: auth (401 sin/secret inválido; 200 con query/bearer) · 405 · body
 * malformado 400 · no-tag y estado!=AGENDADA → ignored · creación válida (fila
 * origen=whapify, estado=confirmada, hash 16hex, gcal_event_id) · rechazos
 * (domingo/fuera-horario/fuera-ventana/mismatch REF → revision) · idempotencia
 * (pre-existente y carrera 23505) · GCal caído → warning no 500 · no-PII.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';

// ─── Supabase mock stateful ────────────────────────────────────────────────--
const mocks = vi.hoisted(() => {
  interface Existing { id: number; gcal_event_id: string | null }
  interface Cfg {
    existing: Existing | null;
    insertImpl: (row: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null };
  }
  const fresh = (): Cfg => ({
    existing: null,
    insertImpl: () => ({ data: { id: 1, gcal_event_id: null }, error: null }),
  });
  let cfg: Cfg = fresh();
  const calls = {
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }>,
    selects: [] as Array<Record<string, unknown>>,
  };

  function makeBuilder() {
    let mode: 'select' | 'insert' | 'update' = 'select';
    let insertedRow: Record<string, unknown> = {};
    let updatePatch: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};

    const resolveTerminal = () => {
      if (mode === 'insert') return cfg.insertImpl(insertedRow);
      if (mode === 'update') {
        calls.updated.push({ patch: updatePatch, filters: { ...filters } });
        return { data: null, error: null };
      }
      calls.selects.push({ ...filters });
      return { data: cfg.existing, error: null };
    };

    const b: Record<string, unknown> = {
      select() { return b; },
      insert(row: Record<string, unknown>) { mode = 'insert'; insertedRow = row; calls.inserted.push(row); return b; },
      update(patch: Record<string, unknown>) { mode = 'update'; updatePatch = patch; return b; },
      eq(col: string, val: unknown) { filters[col] = val; return b; },
      neq(col: string, val: unknown) { filters[`neq_${col}`] = val; return b; },
      limit() { return b; },
      single() { return Promise.resolve(resolveTerminal()); },
      maybeSingle() { calls.selects.push({ ...filters }); return Promise.resolve({ data: cfg.existing, error: null }); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(resolveTerminal()).then(onF, onR);
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

// ─── RSA key para firmar el JWT del Service Account (token fetch mockeado) ─────
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_JSON = JSON.stringify({ client_email: 'sa@giolens-test.iam.gserviceaccount.com', private_key: privateKey });

// ─── fetch stub ────────────────────────────────────────────────────────────--
function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}
let fetchCalls: string[] = [];
// Respuesta configurable del lookup CRM Whapify (GET /api/contacts/{id}).
// Default: quirk 200+{error} → fetchContactPII degrada a null (sin nombre/teléfono).
let contactResponse: unknown = { error: { code: 404 } };
function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'fake-access-token' }) as any;
    if (u.includes('/calendar/v3/calendars/')) return jsonResponse({ id: 'gcal-evt-123' }) as any;
    if (u.includes('/api/contacts/')) return jsonResponse(contactResponse) as any;
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}
const gcalPosts = () => fetchCalls.filter((u) => u.includes('/calendar/v3/calendars/'));
const crmLookups = () => fetchCalls.filter((u) => u.includes('/api/contacts/'));

// ─── req/res helpers ─────────────────────────────────────────────────────────
const SECRET = 'test_wapify_secret_w2';
const AHORA = new Date('2026-05-26T18:00:00Z'); // mar 2026-05-26 11:00 Tijuana

function makeRes() {
  const r: Record<string, unknown> = {
    statusCode: null, body: null, headers: {} as Record<string, string>, ended: false,
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
    end() { r.ended = true; return r; },
    setHeader(name: string, value: string) { (r.headers as Record<string, string>)[name] = value; return r; },
  };
  return r as { statusCode: number; body: any; headers: Record<string, string>;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown; };
}

function makeReq({
  method = 'POST',
  query = {} as Record<string, string>,
  headers = {} as Record<string, string | undefined>,
  body = {} as unknown,
} = {}) {
  const hdrs: Record<string, string | undefined> = { ...headers };
  for (const k of Object.keys(hdrs)) if (hdrs[k] === undefined) delete hdrs[k];
  return { method, query, headers: hdrs, body };
}

function tag(fields: { estado?: string; fecha?: string; hora?: string; ref?: string; int?: string; prod?: string; nombre?: string; tel?: string }) {
  const f = { estado: 'CITA_AGENDADA', fecha: '2026-05-28', hora: '14:00', int: 'I3', ...fields };
  const parts = [
    `ESTADO:${f.estado}`,
    `FECHA:${f.fecha}`,
    `HORA:${f.hora}`,
    ...(f.ref !== undefined ? [`REF:${f.ref}`] : []),
    ...(f.prod !== undefined ? [`PROD:${f.prod}`] : []),
    ...(f.nombre !== undefined ? [`NOMBRE:${f.nombre}`] : []),
    ...(f.tel !== undefined ? [`TEL:${f.tel}`] : []),
    `INT:${f.int}`,
  ];
  return `Listo, te confirmo tu cita. ##${parts.join('|')}##`;
}

describe('POST /api/citas/from-whapify — W2 rama B', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.WAPIFY_WEBHOOK_SECRET = SECRET;
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    process.env.GCAL_SERVICE_ACCOUNT_JSON = SA_JSON;
    process.env.GCAL_CALENDAR_ID = 'citas-giocore@group.calendar.google.com';
    process.env.OPTICA_TIMEZONE = 'America/Tijuana';

    mocks.calls.inserted.length = 0;
    mocks.calls.updated.length = 0;
    mocks.calls.selects.length = 0;
    mocks.resetCfg();
    contactResponse = { error: { code: 404 } }; // default: CRM lookup degrada a null
    installFetch();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AHORA);

    handler = (await import('../api/citas/from-whapify.ts')).default;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (global as { fetch?: unknown }).fetch;
    delete process.env.WAPIFY_WEBHOOK_SECRET;
    delete process.env.OPTICA_TIMEZONE;
    delete process.env.WAPIFY_TOKEN;
  });

  // ── Auth ────────────────────────────────────────────────────────────────--
  it('sin secret → 401, sin escribir nada', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(401);
    expect(mocks.calls.inserted).toHaveLength(0);
    expect(gcalPosts()).toHaveLength(0);
  });

  it('secret inválido → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: 'wrong' }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('fail-closed: sin WAPIFY_WEBHOOK_SECRET configurado → 401', async () => {
    delete process.env.WAPIFY_WEBHOOK_SECRET;
    const res = makeRes();
    await handler(makeReq({ query: { secret: 'anything' }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('secret válido vía Authorization: Bearer → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: `Bearer ${SECRET}` }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
  });

  it('M-1: secret válido vía header x-wapify-secret → 200 (canal evaluado sin short-circuit)', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { 'x-wapify-secret': SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
  });

  // ── Método ────────────────────────────────────────────────────────────────
  it('método != POST → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: { secret: SECRET } }), res);
    expect(res.statusCode).toBe(405);
  });

  // ── Body ────────────────────────────────────────────────────────────────--
  it('body sin message → 400 invalid_body', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('tag CITA_AGENDADA sin contact_id → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}) } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('contact_id_requerido');
  });

  // ── No-op ───────────────────────────────────────────────────────────────--
  it('mensaje sin tag → 200 ignored, sin escritura', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: 'hola, gracias', contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('ignored');
    expect(res.body.reason).toBe('no_tag');
    expect(mocks.calls.inserted).toHaveLength(0);
  });

  it('ESTADO != CITA_AGENDADA → 200 ignored', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ estado: 'CITA_SOLICITADA' }), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.reason).toBe('estado_no_agendada');
    expect(mocks.calls.inserted).toHaveLength(0);
  });

  // ── Creación válida ────────────────────────────────────────────────────────
  it('cita válida → 200 created, fila origen=whapify estado=confirmada hash 16hex + gcal_event_id', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 77, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ fecha: '2026-05-28', hora: '14:00', ref: 'el jueves a las 2' }), contact_id: 'contact-abc' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
    expect(res.body.id).toBe(77);
    expect(res.body.gcal_event_id).toBe('gcal-evt-123');
    expect(res.body.estado).toBe('CITA_AGENDADA');

    expect(mocks.calls.inserted).toHaveLength(1);
    const row = mocks.calls.inserted[0];
    expect(row.origen).toBe('whapify');
    expect(row.estado).toBe('confirmada');
    expect(row.fecha).toBe('2026-05-28');
    expect(row.hora).toBe('14:00');
    expect(row.optometrista).toBeNull();
    const expectedHash = createHash('sha256').update('contact-abc').digest('hex').slice(0, 16);
    expect(row.paciente_hash).toBe(expectedHash);
    expect(String(row.paciente_hash)).toMatch(/^[a-f0-9]{16}$/);

    // GCal creado y reflejado en la fila (lo que el cron pull-gcal usa para omitir).
    expect(gcalPosts()).toHaveLength(1);
    expect(mocks.calls.updated).toHaveLength(1);
    expect(mocks.calls.updated[0].patch.gcal_event_id).toBe('gcal-evt-123');
  });

  // ── Rechazos del resolver → revisión humana, sin crear nada ─────────────────
  it('domingo → 200 revision con motivo domingo, sin insert ni GCal', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ fecha: '2026-05-31', hora: '12:00', ref: '' }), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('revision');
    expect(res.body.estado).toBe('CITA_SOLICITADA');
    expect(res.body._warnings).toContain('cita_revision_humana');
    expect(res.body._warnings).toContain('domingo');
    expect(mocks.calls.inserted).toHaveLength(0);
    expect(gcalPosts()).toHaveLength(0);
  });

  it('fuera de horario (17:00) → 200 revision fuera_horario', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ hora: '17:00', ref: '' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('revision');
    expect(res.body._warnings).toContain('fuera_horario');
  });

  it('fuera de ventana 30d → 200 revision fuera_ventana_30d', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ fecha: '2026-06-26', hora: '12:00', ref: '' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('revision');
    expect(res.body._warnings).toContain('fuera_ventana_30d');
  });

  it('mismatch REF (FECHA sábado vs REF "el lunes") → 200 revision mismatch_ref', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ fecha: '2026-05-30', hora: '12:00', ref: 'el lunes a las 12' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('revision');
    expect(res.body._warnings).toContain('mismatch_ref');
  });

  it('fecha malformada → 200 revision fecha_malformada', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ fecha: 'mañana', hora: '14:00', ref: '' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('revision');
    expect(res.body._warnings).toContain('fecha_malformada');
    expect(mocks.calls.inserted).toHaveLength(0);
  });

  // ── Idempotencia ────────────────────────────────────────────────────────--
  it('cita ya existente (mismo paciente/slot) → 200 idempotent, sin nuevo insert ni GCal', async () => {
    mocks.setCfg({ existing: { id: 42, gcal_event_id: 'gcal-old' } });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('idempotent');
    expect(res.body.id).toBe(42);
    expect(res.body.gcal_event_id).toBe('gcal-old');
    expect(mocks.calls.inserted).toHaveLength(0);
    expect(gcalPosts()).toHaveLength(0);
  });

  it('H-2: el pre-SELECT de idempotencia filtra por origen=whapify (no se confunde con citas dashboard del mismo slot)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    // Ambos pre-SELECT y re-SELECT (si lo hubiera) deben acotar origen=whapify:
    // sin ese filtro, una fila Path B (origen='dashboard') en el mismo slot podría
    // leerse como "ya existe" y bloquear el ingest whapify.
    expect(mocks.calls.selects.length).toBeGreaterThan(0);
    for (const f of mocks.calls.selects) {
      expect(f.origen).toBe('whapify');
      expect(f.neq_estado).toBe('cancelada');
    }
  });

  it('carrera 23505: re-SELECT del ganador → 200 idempotent, sin evento huérfano', async () => {
    // pre-SELECT no encuentra nada; el INSERT pierde la carrera (23505) y entonces
    // aparece el ganador para el re-SELECT. GCal nunca se crea (DB-first).
    mocks.setCfg({
      existing: null,
      insertImpl: () => {
        mocks.setCfg({ existing: { id: 99, gcal_event_id: 'gcal-winner' } });
        return { data: null, error: { code: '23505', message: 'dup idx_citas_whapify_slot_unique' } };
      },
    });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('idempotent');
    expect(res.body.id).toBe(99);
    expect(res.body.gcal_event_id).toBe('gcal-winner');
    expect(gcalPosts()).toHaveLength(0); // no evento huérfano
    // N-2: el camino 23505 DEBE re-SELECTear (pre-SELECT + re-SELECT = 2 lecturas),
    // así devolver 'idempotent' refleja al ganador real, no un estado adivinado.
    expect(mocks.calls.selects).toHaveLength(2);
  });

  // ── GCal caído ──────────────────────────────────────────────────────────--
  it('GCal sin credencial → 200 created con _warnings gcal_unavailable, fila persistida, nunca 500', async () => {
    delete process.env.GCAL_SERVICE_ACCOUNT_JSON;
    mocks.setCfg({ insertImpl: () => ({ data: { id: 5, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
    expect(res.body.gcal_event_id).toBeNull();
    expect(res.body._warnings).toContain('gcal_unavailable');
    expect(mocks.calls.inserted).toHaveLength(1); // slot sí persistido
    expect(gcalPosts()).toHaveLength(0);
  });

  it('DB no configurada → 200 con _warnings db_unavailable, nunca 500', async () => {
    delete process.env.SUPABASE_URL;
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('db_unavailable');
  });

  // ── Parser tolerante del tag ───────────────────────────────────────────--
  it('tag con campo desconocido RUTA: (sub-prompt viejo) → se ignora, cita igual se crea', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 10, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = 'ok ##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|RUTA:A_RAPIDA|REF:el jueves|INT:I3##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].fecha).toBe('2026-05-28');
    expect(mocks.calls.inserted[0].hora).toBe('14:00');
  });

  it('REF con espacios se captura completo (no se trunca) → sin mismatch', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 11, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|REF:el jueves a las dos de la tarde|INT:I2##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created'); // jueves coincide → no mismatch
  });

  it('orden de campos alterado (FECHA antes de ESTADO) → se parsea por clave', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 12, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##FECHA:2026-05-28|HORA:14:00|ESTADO:CITA_AGENDADA|REF:el jueves|INT:I1##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].fecha).toBe('2026-05-28');
  });

  it('REF ausente → no crash, cita se crea (sin mismatch ni warning bloqueante)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 13, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|INT:I3##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created');
  });

  it('REF con `|` literal → continuación no rompe el parseo (greedy hasta INT)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 14, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|REF:el jueves | por la tarde|INT:I3##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('created'); // "jueves" sigue presente → no mismatch
  });

  it('INT ausente → no afecta (no se usa para lógica)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 15, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|REF:el jueves##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
  });

  // ── PII ─────────────────────────────────────────────────────────────────--
  it('la respuesta NO expone message crudo, REF ni contact_id; paciente_hash es hash', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 8, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = tag({ fecha: '2026-05-28', hora: '14:00', ref: 'Juan Pérez el jueves' });
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'contact-secreto-6641234567' } }), res);

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/Juan|Pérez|6641234567|contact-secreto|##ESTADO/i);
    // la fila guarda el hash, no el contact_id crudo
    expect(mocks.calls.inserted[0].paciente_hash).not.toContain('contact-secreto');
    expect(String(mocks.calls.inserted[0].paciente_hash)).toMatch(/^[a-f0-9]{16}$/);
  });

  // ── PROD (producto/motivo) — tag extendido tolerante ───────────────────────--
  it('PROD presente → producto_motivo saneado en la fila', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 20, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ prod: 'Lentes Ray-Ban polarizados' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].producto_motivo).toBe('Lentes Ray-Ban polarizados');
  });

  it('PROD ausente → producto_motivo null (opcional, nunca se inventa)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 21, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].producto_motivo).toBeNull();
  });

  it('PROD con `|` literal → continuación greedy, no rompe el parseo', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 22, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|PROD:lentes | bifocales antirreflejante##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].producto_motivo).toBe('lentes | bifocales antirreflejante');
  });

  it('PROD con controles (\\t,\\n) + espacios → saneado, sin control chars', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 23, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|PROD:miopia\t  progresiva\n|INT:I3##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].producto_motivo).toBe('miopia progresiva');
  });

  it('PROD larguísimo → recortado a 200 chars', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 24, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ prod: 'a'.repeat(500) }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(String(mocks.calls.inserted[0].producto_motivo).length).toBe(200);
  });

  it('ejemplo CANÓNICO del sub-prompt (acento + coma, antes de INT) → se parsea íntegro', async () => {
    // Pin del contrato con el bot: ...|REF:eco123|PROD:lentes progresivos, vé borroso de lejos|INT:I1##
    mocks.setCfg({ insertImpl: () => ({ data: { id: 27, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const message = tag({ ref: 'eco123', prod: 'lentes progresivos, vé borroso de lejos', int: 'I1' });
    await handler(makeReq({ query: { secret: SECRET }, body: { message, contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].producto_motivo).toBe('lentes progresivos, vé borroso de lejos');
  });

  // ── Lookup CRM (nombre/teléfono PII) ───────────────────────────────────────--
  it('lookup CRM OK → nombre/teléfono en la fila, PERO NUNCA en la respuesta', async () => {
    process.env.WAPIFY_TOKEN = 'tok';
    contactResponse = { full_name: 'María Gómez', phone: '+526649998877', email: 'm@x.com' };
    mocks.setCfg({ insertImpl: () => ({ data: { id: 25, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'contact-xyz' } }), res);
    expect(res.body.action).toBe('created');
    expect(crmLookups()).toHaveLength(1);
    expect(mocks.calls.inserted[0].nombre_paciente).toBe('María Gómez');
    expect(mocks.calls.inserted[0].telefono_paciente).toBe('+526649998877');
    // PII jamás en la respuesta del endpoint de captura.
    expect(JSON.stringify(res.body)).not.toMatch(/María|Gómez|6649998877|contact-xyz/i);
  });

  it('lookup CRM falla (404) → nombre/teléfono null + warning, cita igual se crea', async () => {
    process.env.WAPIFY_TOKEN = 'tok';
    contactResponse = { error: { code: 404 } };
    mocks.setCfg({ insertImpl: () => ({ data: { id: 26, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].nombre_paciente).toBeNull();
    expect(mocks.calls.inserted[0].telefono_paciente).toBeNull();
    expect(res.body._warnings).toContain('crm_lookup_skipped');
  });

  it('hit idempotente NO hace lookup CRM (no gasta quota Whapify)', async () => {
    process.env.WAPIFY_TOKEN = 'tok';
    contactResponse = { full_name: 'No debe leerse' };
    mocks.setCfg({ existing: { id: 42, gcal_event_id: 'gcal-old' } });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('idempotent');
    expect(crmLookups()).toHaveLength(0);
  });

  // ── Vía B: campos PII del tag (NOMBRE:/TEL:) — canal confiable para Messenger ──
  it('Messenger (sin token CRM): NOMBRE:/TEL: del tag pueblan la fila', async () => {
    // Sin WAPIFY_TOKEN → fetchContactPII devuelve null (simula Messenger sin teléfono CRM).
    mocks.setCfg({ insertImpl: () => ({ data: { id: 30, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ nombre: 'Ana López', tel: '+52 664 111 2233' }), contact_id: 'msgr-1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].nombre_paciente).toBe('Ana López');
    expect(mocks.calls.inserted[0].telefono_paciente).toBe('+52 664 111 2233');
    expect(res.body._warnings).toContain('nombre_from_tag');
    expect(res.body._warnings).toContain('telefono_from_tag');
    // PII del tag jamás en la respuesta.
    expect(JSON.stringify(res.body)).not.toMatch(/Ana|López|1112233/i);
  });

  it('NOMBRE/TEL ausentes → columnas null (opcional, nunca se inventa)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 31, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].nombre_paciente).toBeNull();
    expect(mocks.calls.inserted[0].telefono_paciente).toBeNull();
  });

  it('prioridad por campo: CRM gana en nombre; tag rellena el teléfono que el CRM no trae', async () => {
    // WhatsApp típico enriquecido por CRM con nombre, pero sin phone en este caso →
    // el TEL del tag rellena. El NOMBRE del CRM tiene prioridad sobre el del tag.
    process.env.WAPIFY_TOKEN = 'tok';
    contactResponse = { full_name: 'Nombre CRM', phone: '' }; // phone vacío → null
    mocks.setCfg({ insertImpl: () => ({ data: { id: 32, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ nombre: 'Nombre Tag', tel: '6649998877' }), contact_id: 'c1' } }), res);
    expect(mocks.calls.inserted[0].nombre_paciente).toBe('Nombre CRM');   // CRM > tag
    expect(mocks.calls.inserted[0].telefono_paciente).toBe('6649998877'); // tag rellena
    expect(res.body._warnings).toContain('telefono_from_tag');
    expect(res.body._warnings).not.toContain('nombre_from_tag'); // CRM cubrió el nombre
  });

  it('TEL con basura no-telefónica → se descarta; sólo dígitos/+/-/() sobreviven', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 33, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ tel: 'llámame al (664) 123-4567 porfa' }), contact_id: 'c1' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].telefono_paciente).toBe('(664) 123-4567');
  });

  it('TEL sin ningún dígito → null (no es teléfono)', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 34, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ tel: 'no sé mi número' }), contact_id: 'c1' } }), res);
    expect(mocks.calls.inserted[0].telefono_paciente).toBeNull();
  });

  it('NOMBRE con controles + espacios → saneado; larguísimo → recortado a 120', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 35, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    const msg = '##ESTADO:CITA_AGENDADA|FECHA:2026-05-28|HORA:14:00|NOMBRE:María\t  José\nGarcía##';
    await handler(makeReq({ query: { secret: SECRET }, body: { message: msg, contact_id: 'c1' } }), res);
    expect(mocks.calls.inserted[0].nombre_paciente).toBe('María José García');
    // tope 120
    const res2 = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({ nombre: 'x'.repeat(300) }), contact_id: 'c2' } }), res2);
    expect(String(mocks.calls.inserted[1].nombre_paciente).length).toBe(120);
  });

  it('contact_id (raw) se persiste en la fila PERO NUNCA en la respuesta', async () => {
    mocks.setCfg({ insertImpl: () => ({ data: { id: 36, gcal_event_id: null }, error: null }) });
    const res = makeRes();
    await handler(makeReq({ query: { secret: SECRET }, body: { message: tag({}), contact_id: 'contact-raw-99887766' } }), res);
    expect(res.body.action).toBe('created');
    expect(mocks.calls.inserted[0].contact_id).toBe('contact-raw-99887766');
    // el contact_id raw nunca viaja en la respuesta del endpoint de captura.
    expect(JSON.stringify(res.body)).not.toMatch(/contact-raw|99887766/i);
  });
});
