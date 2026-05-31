/**
 * tests/citas-write-ui.test.ts — BFF de ESCRITURA POST/PUT /api/citas-write-ui.
 *
 * Resuelve PARADA-1: el browser del dashboard confirma/cancela/crea citas SIN
 * Bearer. Invariantes que blinda:
 *   - Auth por Origin/Referer (NO Bearer): origen ajeno/ausente → 403.
 *   - Superficie MÍNIMA: sólo POST (crear) y PUT (confirmar/cancelar). GET/DELETE → 405.
 *   - PUT narrowing: estado ∉ {confirmada, cancelada} → 400; y SÓLO `estado` se
 *     propaga al núcleo (notas/optometrista del body se ignoran — no se puede
 *     editar campos arbitrarios desde el browser).
 *   - Lógica de negocio compartida con /api/citas (mismas validaciones/errores).
 *   - Edge: id inexistente/ausente, payload malformado, doble confirmar idempotente.
 *   - Cache-Control: no-store.
 *
 * Mock @supabase/supabase-js: builder stateful que distingue insert/update/select
 * y registra los `update set` para verificar el narrowing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface State {
    insertRows: Array<Record<string, unknown>>;
    updateSets: Array<Record<string, unknown>>;
    existingRow: Record<string, unknown> | null;
    insertError: { code?: string; message?: string } | null;
    updateError: { code?: string; message?: string } | null;
    insertId: number;
    updateId: number;
  }
  const fresh = (): State => ({
    insertRows: [],
    updateSets: [],
    existingRow: null,
    insertError: null,
    updateError: null,
    insertId: 123,
    updateId: 7,
  });
  let state: State = fresh();

  function makeBuilder() {
    const b: {
      _mode: 'insert' | 'update' | 'select' | null;
      _row?: Record<string, unknown>;
      _set?: Record<string, unknown>;
      insert: (row: Record<string, unknown>) => typeof b;
      update: (set: Record<string, unknown>) => typeof b;
      select: (cols?: unknown, opts?: unknown) => typeof b;
      eq: () => typeof b;
      order: () => typeof b;
      range: () => typeof b;
      gte: () => typeof b;
      lte: () => typeof b;
      ilike: () => typeof b;
      single: () => Promise<{ data: unknown; error: unknown }>;
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise<unknown>;
    } = {
      _mode: null,
      insert(row) { this._mode = 'insert'; this._row = row; state.insertRows.push(row); return this; },
      update(set) { this._mode = 'update'; this._set = set; state.updateSets.push(set); return this; },
      select() { if (!this._mode) this._mode = 'select'; return this; },
      eq() { return this; },
      order() { return this; },
      range() { return this; },
      gte() { return this; },
      lte() { return this; },
      ilike() { return this; },
      single() {
        if (this._mode === 'insert') {
          return Promise.resolve(
            state.insertError
              ? { data: null, error: state.insertError }
              : { data: { ...this._row, id: state.insertId }, error: null },
          );
        }
        if (this._mode === 'update') {
          return Promise.resolve(
            state.updateError
              ? { data: null, error: state.updateError }
              : { data: { id: state.updateId, ...this._set }, error: null },
          );
        }
        return Promise.resolve({ data: state.existingRow, error: null });
      },
      then(onF, onR) {
        // Sólo para awaits sin .single() (ej. update de confirmacion_enviada_at).
        return Promise.resolve({ data: null, error: null, count: 0 }).then(onF, onR);
      },
    };
    return b;
  }

  const createClient = vi.fn(() => ({ from: () => makeBuilder() }));
  const sendWhatsApp = vi.fn(async () => ({ ok: true }));

  return {
    createClient,
    sendWhatsApp,
    getState: () => state,
    reset: () => { state = fresh(); },
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../agents/_shared/providers/wapify-notify.js', () => ({ sendWhatsApp: mocks.sendWhatsApp }));
vi.mock('../agents/_shared/providers/wapify-notify',    () => ({ sendWhatsApp: mocks.sendWhatsApp }));
vi.mock('../agents/_shared/providers/wapify-notify.ts', () => ({ sendWhatsApp: mocks.sendWhatsApp }));

const ALLOWED = 'https://giolens-dashboard.vercel.app';

interface ResLike {
  statusCode: number;
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
  status(c: number): ResLike;
  json(b: unknown): ResLike;
  end(): ResLike;
  setHeader(k: string, v: string): ResLike;
}

function makeRes(): ResLike {
  const r: ResLike = {
    statusCode: 0,
    body: undefined,
    ended: false,
    headers: {},
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
  };
  return r;
}

function makeReq(opts: {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return {
    method: opts.method ?? 'POST',
    query: opts.query ?? {},
    headers: opts.headers ?? { origin: ALLOWED },
    body: opts.body,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: (req: any, res: any) => Promise<void>;

describe('api/citas-write-ui.ts — BFF de escritura Origin-gated', () => {
  beforeEach(async () => {
    mocks.reset();
    mocks.createClient.mockClear();
    mocks.sendWhatsApp.mockClear();
    process.env.SUPABASE_URL = 'https://fake.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_fake';
    delete process.env.GCAL_CALENDAR_ID;
    delete process.env.WAPIFY_PIPELINE_CITAS;
    delete process.env.WHATSAPP_ISAAC;
    delete process.env.CRON_SECRET;
    handler = (await import('../api/citas-write-ui.ts')).default;
  });
  afterEach(() => { vi.clearAllMocks(); });

  // ── Gating / método ──────────────────────────────────────────────────────

  it('OPTIONS → 204 + CORS con POST y PUT en Allow-Methods', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('PUT');
  });

  it('GET → 405 method_not_allowed (la lectura es /api/citas-ui)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect((res.body as { error: string }).error).toBe('method_not_allowed');
    expect(res.headers['Allow']).toContain('POST');
  });

  it('DELETE → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST sin Origin ni Referer → 403 origin_forbidden', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: {}, body: {} }), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('origin_forbidden');
    // No debe haber tocado la DB.
    expect(mocks.getState().insertRows.length).toBe(0);
  });

  it('PUT con Origin de otro dominio → 403', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', headers: { origin: 'https://evil.example.com' }, query: { id: '7' }, body: { estado: 'confirmada' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('Referer válido (sin Origin) también pasa el gate', async () => {
    mocks.getState().existingRow = { optometrista: 'Dra. Ruiz', estado: 'agendada', confirmacion_enviada_at: null, gcal_event_id: null };
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', headers: { referer: 'https://giolens-dashboard.vercel.app/' }, query: { id: '7' }, body: { estado: 'confirmada' } }), res);
    expect(res.statusCode).toBe(200);
  });

  // ── Crear ────────────────────────────────────────────────────────────────

  it('POST crear válido → 201 + id (delega al núcleo)', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: { fecha: '2026-06-01', hora: '10:00', optometrista: 'Dra. Ruiz', tipo_consulta: 'revision_visual', paciente_hash: '0123456789abcdef' },
    }), res);
    expect(res.statusCode).toBe(201);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect((res.body as { id: number }).id).toBe(123);
    expect(mocks.getState().insertRows.length).toBe(1);
  });

  it('POST crear sin fecha → 400 (validación del núcleo)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { hora: '10:00', optometrista: 'Dra. Ruiz', paciente_hash: '0123456789abcdef' } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/fecha/i);
  });

  it('POST crear con estado=realizada → 400 accion_no_permitida (narrowing de creación, no toca DB)', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: { fecha: '2026-06-01', hora: '10:00', optometrista: 'Dra. Ruiz', paciente_hash: '0123456789abcdef', estado: 'realizada' },
    }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('accion_no_permitida');
    expect(mocks.getState().insertRows.length).toBe(0);
  });

  it('POST crear con estado=confirmada (walk-in) → 201 permitido', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: { fecha: '2026-06-01', hora: '10:00', optometrista: 'Dra. Ruiz', paciente_hash: '0123456789abcdef', estado: 'confirmada' },
    }), res);
    expect(res.statusCode).toBe(201);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  // ── Confirmar / Cancelar ───────────────────────────────────────────────────

  it('PUT confirmar (estado=confirmada) → 200', async () => {
    mocks.getState().existingRow = { optometrista: 'Dra. Ruiz', estado: 'agendada', confirmacion_enviada_at: null, gcal_event_id: null, fecha: '2026-06-01', hora: '10:00', tipo_consulta: 'revision_visual', paciente_hash: '0123456789abcdef' };
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' } }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('PUT cancelar (estado=cancelada) → 200 y SÓLO propaga `estado` (ignora notas/optometrista del body)', async () => {
    mocks.getState().existingRow = { optometrista: null, estado: 'agendada', confirmacion_enviada_at: null, gcal_event_id: null };
    const res = makeRes();
    await handler(makeReq({
      method: 'PUT',
      query: { id: '7' },
      body: { estado: 'cancelada', notas: 'INYECCION', optometrista: 'ATACANTE', gcal_event_id: 'x' },
    }), res);
    expect(res.statusCode).toBe(200);
    // Narrowing: el único update que llegó al núcleo es { estado: 'cancelada' }.
    const sets = mocks.getState().updateSets;
    expect(sets.length).toBe(1);
    expect(sets[0]).toEqual({ estado: 'cancelada' });
    expect(sets[0]).not.toHaveProperty('notas');
    expect(sets[0]).not.toHaveProperty('optometrista');
  });

  it('PUT con estado=realizada → 400 accion_no_permitida (no llega al núcleo)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '7' }, body: { estado: 'realizada' } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('accion_no_permitida');
    expect(mocks.getState().updateSets.length).toBe(0);
  });

  it('PUT con estado=agendada → 400 accion_no_permitida', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '7' }, body: { estado: 'agendada' } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('accion_no_permitida');
  });

  it('PUT sin estado → 400 accion_no_permitida', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '7' }, body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('accion_no_permitida');
  });

  it('PUT confirmar sin id → 400 (id requerido, del núcleo)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', body: { estado: 'confirmada' } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/id/i);
  });

  // ── Idempotencia (heredada del núcleo) ─────────────────────────────────────

  it('PUT confirmar 2x → Wapify no se redispara (idempotente vía confirmacion_enviada_at)', async () => {
    // 2ª confirmación: la cita ya está confirmada y con timestamp → sin reenvío.
    mocks.getState().existingRow = { optometrista: 'Dra. Ruiz', estado: 'confirmada', confirmacion_enviada_at: '2026-05-30T10:00:00Z', gcal_event_id: null };
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' } }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.sendWhatsApp).not.toHaveBeenCalled();
  });

  // ── Headers ────────────────────────────────────────────────────────────────

  it('Cache-Control: no-store en la respuesta', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: {}, body: {} }), res);
    expect(res.headers['Cache-Control']).toContain('no-store');
  });
});
