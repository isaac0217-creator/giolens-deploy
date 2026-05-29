/**
 * Frente G · Sesión 10 · Tests del cron pull-gcal (doble-escritura opción a).
 *
 * Decisión: DECISION_DOBLE_ESCRITURA_CALENDAR.md §4 (≥8 tests, GCal mockeado).
 *
 * Estrategia de mocks:
 *   - @supabase/supabase-js: builder fake (select().in() para lookup, insert()).
 *   - global.fetch: dispatch por URL → token OAuth + listEvents. Ejerce el cliente
 *     REAL agents/_shared/providers/gcal.ts (incluye firma JWT con clave RSA
 *     generada en test) en vez de stub del módulo, evitando ambigüedad .js↔.ts.
 *
 * Cobertura: Auth 401/403/200 · inserción origen='whapify' · skip existentes ·
 * idempotencia (doble run) · slot_conflict (23505) sin romper · GCal unavailable
 * → warning no 500 · no-PII en respuesta · mapeo timezone OPTICA_TIMEZONE ·
 * filtra cancelados/all-day · 405.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';

// ─── Supabase mock ───────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  interface Cfg {
    existingIds: string[];
    lookupError: { code?: string; message?: string } | null;
    insertError: (row: Record<string, unknown>) => { code?: string; message?: string } | null;
  }
  const fresh = (): Cfg => ({ existingIds: [], lookupError: null, insertError: () => null });
  let cfg: Cfg = fresh();
  const calls = {
    inserted: [] as Array<Record<string, unknown>>,
    inArgs: [] as Array<{ col: string; vals: unknown }>,
    fromTables: [] as string[],
  };

  const builder: Record<string, unknown> = {
    select() { return builder; },
    in(col: string, vals: unknown) {
      calls.inArgs.push({ col, vals });
      if (cfg.lookupError) return Promise.resolve({ data: null, error: cfg.lookupError });
      return Promise.resolve({
        data: cfg.existingIds.map((id) => ({ gcal_event_id: id })),
        error: null,
      });
    },
    insert(row: Record<string, unknown>) {
      calls.inserted.push(row);
      return Promise.resolve({ error: cfg.insertError(row) });
    },
  };

  const client = {
    from(t: string) { calls.fromTables.push(t); return builder; },
  };

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

let currentEvents: unknown[] = [];

function installFetch() {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'fake-access-token' }) as any;
    if (u.includes('/calendar/v3/calendars/')) return jsonResponse({ items: currentEvents }) as any;
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

// ─── req/res helpers ─────────────────────────────────────────────────────────
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

function makeReq({ method = 'POST', headers = {} as Record<string, string | undefined> } = {}) {
  const hdrs: Record<string, string | undefined> = {
    authorization: `Bearer ${process.env.CRON_SECRET}`,
    ...headers,
  };
  for (const k of Object.keys(hdrs)) if (hdrs[k] === undefined) delete hdrs[k];
  return { method, headers: hdrs };
}

function evt(id: string, dateTime: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'confirmed', summary: 'Cita', start: { dateTime }, end: { dateTime }, ...extra };
}

describe('cron pull-gcal — doble-escritura opción (a)', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test_cron_secret_pullgcal';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    process.env.GCAL_SERVICE_ACCOUNT_JSON = SA_JSON;
    process.env.GCAL_CALENDAR_ID = 'citas-giocore@group.calendar.google.com';
    process.env.OPTICA_TIMEZONE = 'America/Tijuana';

    mocks.calls.inserted.length = 0;
    mocks.calls.inArgs.length = 0;
    mocks.calls.fromTables.length = 0;
    mocks.resetCfg();
    currentEvents = [];
    installFetch();

    handler = (await import('../api/cron/pull-gcal.ts')).default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as { fetch?: unknown }).fetch;
  });

  // ── Auth ────────────────────────────────────────────────────────────────
  it('sin header Authorization → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: undefined } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('header presente pero inválido → 403', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: 'Bearer wrong' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('Bearer válido → 200', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('método no permitido → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  // ── Inserción ─────────────────────────────────────────────────────────────
  it("inserta filas nuevas con origen='whapify' y estado='confirmada'", async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z')];
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(mocks.calls.inserted).toHaveLength(1);
    const row = mocks.calls.inserted[0];
    expect(row.origen).toBe('whapify');
    expect(row.estado).toBe('confirmada');
    expect(row.gcal_event_id).toBe('ev1');
    expect(String(row.paciente_hash)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('paciente_hash es placeholder sha256(gcal_event_id)[:16], no derivado de PII', async () => {
    currentEvents = [evt('ev-xyz', '2026-05-29T17:00:00Z', { summary: 'Juan Pérez 6641234567' })];
    const res = makeRes();
    await handler(makeReq(), res);
    const expected = createHash('sha256').update('ev-xyz').digest('hex').slice(0, 16);
    expect(mocks.calls.inserted[0].paciente_hash).toBe(expected);
  });

  // ── Skip / idempotencia ───────────────────────────────────────────────────
  it('omite eventos ya presentes en citas (lookup por gcal_event_id)', async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z'), evt('ev2', '2026-05-29T18:00:00Z')];
    mocks.setCfg({ existingIds: ['ev1'] });
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toBeGreaterThanOrEqual(1);
    expect(mocks.calls.inserted.map((r) => r.gcal_event_id)).toEqual(['ev2']);
  });

  it('idempotente: segunda corrida con los mismos eventos ya insertados no inserta nada', async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z'), evt('ev2', '2026-05-29T18:00:00Z')];

    // Run 1: nada existe → inserta ambos.
    let res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.inserted).toBe(2);
    const insertedIds = mocks.calls.inserted.map((r) => String(r.gcal_event_id));

    // Run 2: ahora ya existen → 0 inserciones, mismo estado.
    mocks.calls.inserted.length = 0;
    mocks.setCfg({ existingIds: insertedIds });
    res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.inserted).toBe(0);
    expect(mocks.calls.inserted).toHaveLength(0);
    expect(res.body.skipped).toBeGreaterThanOrEqual(2);
  });

  // ── Conflicto de slot ─────────────────────────────────────────────────────
  it('choque real de slot (23505) se cuenta en conflicts y NO rompe el cron', async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z'), evt('ev2', '2026-05-29T18:00:00Z')];
    mocks.setCfg({
      insertError: (row) => (row.gcal_event_id === 'ev1' ? { code: '23505', message: 'dup' } : null),
    });
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.conflicts).toBe(1);
    expect(res.body.inserted).toBe(1); // ev2 sí entra
  });

  // ── GCal caído ─────────────────────────────────────────────────────────────
  it('GCal sin credencial → 200 con _warnings, nunca 500', async () => {
    delete process.env.GCAL_SERVICE_ACCOUNT_JSON;
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('gcal_unavailable');
    expect(mocks.calls.inserted).toHaveLength(0);
  });

  // ── PII ─────────────────────────────────────────────────────────────────--
  it('la respuesta NO expone PII ni payload crudo del evento', async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z', { summary: 'Juan Pérez 6641234567' })];
    const res = makeRes();
    await handler(makeReq(), res);

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/Juan|Pérez|6641234567|summary/i);
    expect(Object.keys(res.body).sort()).toEqual(
      ['_warnings', 'conflicts', 'errors', 'generated_at', 'inserted', 'ok', 'pulled', 'skipped'].sort(),
    );
  });

  // ── Timezone ───────────────────────────────────────────────────────────────
  it('mapea fecha/hora locales según OPTICA_TIMEZONE (no asume UTC)', async () => {
    currentEvents = [evt('ev1', '2026-05-29T17:00:00Z')]; // 17:00 UTC

    process.env.OPTICA_TIMEZONE = 'America/Tijuana'; // UTC-7 → 10:00
    let res = makeRes();
    await handler(makeReq(), res);
    expect(mocks.calls.inserted[0].fecha).toBe('2026-05-29');
    expect(mocks.calls.inserted[0].hora).toBe('10:00');

    // Cambiar tz cambia la hora local derivada del mismo instante.
    mocks.calls.inserted.length = 0;
    process.env.OPTICA_TIMEZONE = 'America/Mexico_City'; // UTC-6 → 11:00
    res = makeRes();
    await handler(makeReq(), res);
    expect(mocks.calls.inserted[0].hora).toBe('11:00');
  });

  // ── Filtros ─────────────────────────────────────────────────────────────--
  it('omite eventos cancelados y all-day (sin dateTime concreto)', async () => {
    currentEvents = [
      evt('ev1', '2026-05-29T17:00:00Z'),
      { id: 'ev-cancel', status: 'cancelled', start: { dateTime: '2026-05-29T18:00:00Z' } },
      { id: 'ev-allday', status: 'confirmed', start: { date: '2026-05-30' } },
    ];
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.body.inserted).toBe(1);
    expect(mocks.calls.inserted.map((r) => r.gcal_event_id)).toEqual(['ev1']);
    expect(res.body.skipped).toBeGreaterThanOrEqual(2);
  });
});
