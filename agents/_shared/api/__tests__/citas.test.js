/**
 * GIOCORE Frente G — tests del handler `api/citas.ts` (SPEC A-5).
 *
 * Cubre:
 *   - A-1 (Auth + CORS)
 *   - A-2/A-3 (race condition 23505 + transacción ordenada)
 *   - A-4 (regex fecha/hora/hash, Wapify idempotente con confirmacion_enviada_at,
 *           escape ilike, PUT en Allow-Methods)
 *   - PII no negociable (POST + GET)
 *   - Headers Cache-Control + Vary
 *
 * Patrón clonado de expediente.test.js (mismo runner Vitest 2.x).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    citasInserts: [],
    citasUpdates: [],   // { set, eq }
    citasSelects: [],   // { cols, opts }
    citasIlikes:  [],   // { col, pat }
    citasGtes:    [],
    citasLtes:    [],
    citasEqs:     [],   // (col, val) en modo select
  };

  let citasCfg = {};
  const setCitasCfg = (c) => { citasCfg = c; };

  const makeBuilder = () => {
    const b = {
      _mode: null,    // 'insert' | 'select' | 'update'
      _row: null,
      _set: null,
      _filters: {},
      _cols: null,

      insert(row) {
        this._mode = 'insert';
        this._row = row;
        calls.citasInserts.push({ row });
        return this;
      },

      select(cols, selOpts) {
        this._cols = cols;
        if (this._mode !== 'insert' && this._mode !== 'update') this._mode = 'select';
        calls.citasSelects.push({ cols, opts: selOpts });
        return this;
      },

      update(set) {
        this._mode = 'update';
        this._set = set;
        return this;
      },

      eq(col, val) {
        this._filters[col] = val;
        if (this._mode === 'update') {
          calls.citasUpdates.push({ set: this._set, eq: { [col]: val } });
        } else if (this._mode === 'select') {
          calls.citasEqs.push({ col, val });
        }
        return this;
      },

      ilike(col, pat) {
        this._filters[`ilike:${col}`] = pat;
        calls.citasIlikes.push({ col, pat });
        return this;
      },

      gte(col, val) { this._filters[`gte:${col}`] = val; calls.citasGtes.push({ col, val }); return this; },
      lte(col, val) { this._filters[`lte:${col}`] = val; calls.citasLtes.push({ col, val }); return this; },
      order() { return this; },
      range() { return this; },

      single() {
        if (this._mode === 'insert') {
          if (citasCfg.simulateSlotConflict) {
            return Promise.resolve({
              data: null,
              error: { code: '23505', message: 'duplicate key uq_citas_slot' },
            });
          }
          return Promise.resolve({
            data: { id: citasCfg.insertedId ?? 42, ...this._row },
            error: null,
          });
        }
        if (this._mode === 'update') {
          if (citasCfg.updateError) {
            return Promise.resolve({ data: null, error: { message: 'update failed' } });
          }
          return Promise.resolve({
            data: { id: this._filters.id ?? citasCfg.insertedId ?? 42, ...this._set },
            error: null,
          });
        }
        // mode === 'select'
        return Promise.resolve({ data: citasCfg.existingRow ?? null, error: null });
      },

      // Builder thenable — soporta `await query` (GET) y `await update.eq` (POST/PUT timestamp)
      then(resolve, reject) {
        let result;
        if (this._mode === 'update') {
          result = { data: null, error: null };
        } else {
          result = {
            data:  citasCfg.listRows  ?? [],
            error: null,
            count: citasCfg.listCount ?? 0,
          };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
      catch(rej) { return this.then(undefined, rej); },
    };
    return b;
  };

  const supabaseClient = {
    from(table) {
      if (table === 'citas') return makeBuilder();
      throw new Error(`tabla no mockeada: ${table}`);
    },
  };

  return {
    calls,
    setCitasCfg,
    createClient: vi.fn(() => supabaseClient),
    sendWhatsApp: vi.fn(() => Promise.resolve({ ok: true })),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../../providers/wapify-notify.js', () => ({ sendWhatsApp: mocks.sendWhatsApp }));
vi.mock('../../providers/wapify-notify',    () => ({ sendWhatsApp: mocks.sendWhatsApp }));
vi.mock('../../providers/wapify-notify.ts', () => ({ sendWhatsApp: mocks.sendWhatsApp }));

// fetch global (GCal) — defensivo; sin envs no se llega a ejecutar
global.fetch = vi.fn();

function makeRes() {
  const r = {
    statusCode: null, body: null, headers: {}, ended: false,
    status(code) { r.statusCode = code; return r; },
    json(body)   { r.body = body;       return r; },
    end()        { r.ended = true;      return r; },
    setHeader(name, value) { r.headers[name] = value; return r; },
  };
  return r;
}

function makeReq({ method = 'GET', headers = {}, body = null, query = {} } = {}) {
  const hdrs = {
    authorization: `Bearer ${process.env.CRON_SECRET}`,
    origin:        'https://giolens-dashboard.vercel.app',
    ...headers,
  };
  // Permitir borrar headers pasando undefined
  for (const k of Object.keys(hdrs)) {
    if (hdrs[k] === undefined) delete hdrs[k];
  }
  return { method, headers: hdrs, body, query };
}

describe('api/citas.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    process.env.CRON_SECRET               = 'test_cron_secret_123';
    process.env.SUPABASE_URL              = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    // GCal y Wapify intencionalmente NO seteados → graceful fallback por default
    delete process.env.GCAL_CALENDAR_ID;
    delete process.env.GCAL_SERVICE_ACCOUNT_JSON;
    delete process.env.WAPIFY_PIPELINE_CITAS;
    delete process.env.WHATSAPP_ISAAC;

    Object.values(mocks.calls).forEach(arr => arr.length = 0);
    mocks.setCitasCfg({});
    mocks.sendWhatsApp.mockReset();
    mocks.sendWhatsApp.mockResolvedValue({ ok: true });
    global.fetch.mockReset();

    handler = (await import('../../../../api/citas.ts')).default;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 1 · Auth + CORS (A-1)
  // ─────────────────────────────────────────────────────────────────────────

  it('T01 · OPTIONS sin Bearer → 200 + CORS headers (con PUT)', async () => {
    const req = makeReq({ method: 'OPTIONS', headers: { authorization: undefined } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://giolens-dashboard.vercel.app');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('PUT');
    expect(res.ended).toBe(true);
  });

  it('T02 · GET sin Bearer → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', headers: { authorization: undefined } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('T03 · POST sin Bearer → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { authorization: undefined }, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('T04 · PUT sin Bearer → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'PUT', headers: { authorization: undefined }, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('T05 · GET con Bearer mal → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', headers: { authorization: 'Bearer wrong' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('T06 · DELETE con Bearer válido → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 2 · POST validación (A-4 R-7 + hash)
  // ─────────────────────────────────────────────────────────────────────────

  it('T07 · POST sin fecha → 400 "fecha requerida"', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('fecha requerida');
  });

  it('T08 · POST con fecha="abcdefghij" → 400 "YYYY-MM-DD"', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: { fecha: 'abcdefghij', hora: '10:00', paciente_email: 'x@y.com' },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('YYYY-MM-DD');
  });

  it('T09 · POST con hora="25:00" → 400 "HH:MM"', async () => {
    // Nota: regex HORA_RE matchea formato, no rango. "25:00" pasa HORA_RE.
    // Test rechaza vía formato — usamos "2500" (sin ":") para que falle regex.
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: { fecha: '2026-06-01', hora: '2500', paciente_email: 'x@y.com' },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('HH:MM');
  });

  it('T10 · POST con tipo_consulta="tarot" → 400 + lista valid', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_email: 'x@y.com', tipo_consulta: 'tarot',
      },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('tipo_consulta');
    expect(Array.isArray(res.body.valid)).toBe(true);
    expect(res.body.valid).toContain('revision_visual');
  });

  it('T11 · POST sin email + sin telefono + sin hash → 400', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_email: '', paciente_telefono: '',
      },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/paciente_hash|paciente_email|paciente_telefono/);
  });

  it('T12 · POST con paciente_hash="XYZ123" → 400 "16 chars hex"', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'XYZ123',
      },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('16 chars hex');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 3 · POST happy path + race condition (A-2 + A-3)
  // ─────────────────────────────────────────────────────────────────────────

  it('T13 · POST válido + sin GCal env → 201 + gcal_event_id null + sin PII', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual',
      },
    }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.gcal_event_id).toBeNull();
    expect(res.body.cita).not.toHaveProperty('paciente_email');
    expect(res.body.cita).not.toHaveProperty('paciente_telefono');
    expect(res.body.cita).not.toHaveProperty('paciente_nombre');
  });

  it('T14 · POST con conflict slot (23505) → 409 slot_ocupado', async () => {
    mocks.setCitasCfg({ simulateSlotConflict: true });
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual',
      },
    }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('slot_ocupado');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 4 · POST Wapify idempotencia (A-4 R-4 POST)
  // ─────────────────────────────────────────────────────────────────────────

  it('T15 · POST estado=confirmada + Wapify ok → sendWhatsApp 1x + UPDATE timestamp', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';

    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual',
        estado: 'confirmada',
      },
    }), res);

    expect(res.statusCode).toBe(201);
    expect(mocks.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(mocks.calls.citasUpdates.some(u =>
      u.set.confirmacion_enviada_at && u.eq.id === 42
    )).toBe(true);
  });

  it('T16 · POST estado=confirmada + Wapify throw → 201 + NO UPDATE timestamp', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';
    mocks.sendWhatsApp.mockReset();
    mocks.sendWhatsApp.mockRejectedValue(new Error('wapify 500'));

    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual',
        estado: 'confirmada',
      },
    }), res);

    expect(res.statusCode).toBe(201);
    expect(mocks.calls.citasUpdates.some(u => u.set.confirmacion_enviada_at)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 5 · GET paginación + ilike escape (A-4 R-11)
  // ─────────────────────────────────────────────────────────────────────────

  it('T17 · GET sin filtros → 200 + shape correcta', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, total: 0, page: 1, page_size: 50,
    });
    expect(Array.isArray(res.body.citas)).toBe(true);
  });

  it('T18 · GET con page_size=10000 → clamp a 100', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: { page_size: '10000' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.page_size).toBe(100);
  });

  it('T19 · GET con optometrista="%abc" → ilike escapa wildcard', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', query: { optometrista: '%abc' } }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.calls.citasIlikes.length).toBeGreaterThanOrEqual(1);
    const pat = mocks.calls.citasIlikes[0].pat;
    expect(pat).toBe('%\\%abc%');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 6 · PUT idempotencia + tracking (A-4 R-4 PUT — el más crítico)
  // ─────────────────────────────────────────────────────────────────────────

  it('T20 · PUT confirmada cuando ex.estado=agendada + timestamp null → Wapify 1x + UPDATE', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';
    mocks.setCitasCfg({
      existingRow: {
        id: 7, estado: 'agendada', confirmacion_enviada_at: null,
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual', gcal_event_id: null,
      },
    });

    const res = makeRes();
    await handler(makeReq({
      method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(mocks.calls.citasUpdates.some(u =>
      u.set.confirmacion_enviada_at && u.eq.id === 7
    )).toBe(true);
  });

  it('T21 · PUT confirmada cuando ex.estado=confirmada ya → Wapify NO llamado', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';
    mocks.setCitasCfg({
      existingRow: {
        id: 7, estado: 'confirmada', confirmacion_enviada_at: null,
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
      },
    });

    const res = makeRes();
    await handler(makeReq({
      method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('T22 · PUT confirmada cuando confirmacion_enviada_at !== null → Wapify NO llamado', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';
    mocks.setCitasCfg({
      existingRow: {
        id: 7, estado: 'agendada',
        confirmacion_enviada_at: '2026-05-26T22:00:00Z',
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
      },
    });

    const res = makeRes();
    await handler(makeReq({
      method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('T23 · PUT con id inexistente → 500 graceful (update error)', async () => {
    mocks.setCitasCfg({ existingRow: null, updateError: true });
    const res = makeRes();
    await handler(makeReq({
      method: 'PUT', query: { id: '9999' }, body: { estado: 'confirmada' },
    }), res);
    expect(res.statusCode).toBe(500);
  });

  it('T24 · PUT 2x consecutivos estado=confirmada → Wapify 1x total (integración)', async () => {
    process.env.WAPIFY_PIPELINE_CITAS = 'pipe_citas_123';
    process.env.WHATSAPP_ISAAC        = '+5215555555555';

    mocks.setCitasCfg({
      existingRow: {
        id: 7, estado: 'agendada', confirmacion_enviada_at: null,
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
        tipo_consulta: 'revision_visual',
      },
    });
    await handler(makeReq({
      method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' },
    }), makeRes());

    // Segunda llamada: ahora ex ya está confirmada + tiene timestamp
    mocks.setCitasCfg({
      existingRow: {
        id: 7, estado: 'confirmada',
        confirmacion_enviada_at: '2026-05-26T22:00:00Z',
        fecha: '2026-06-01', hora: '10:00',
        paciente_hash: 'a1b2c3d4e5f6a7b8',
      },
    });
    await handler(makeReq({
      method: 'PUT', query: { id: '7' }, body: { estado: 'confirmada' },
    }), makeRes());

    expect(mocks.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 7 · PII (no negociable)
  // ─────────────────────────────────────────────────────────────────────────

  it('T25 · POST response → sin PII (email/telefono/nombre)', async () => {
    const res = makeRes();
    await handler(makeReq({
      method: 'POST',
      body: {
        fecha: '2026-06-01', hora: '10:00',
        paciente_email:    'isaac@example.com',
        paciente_telefono: '+521555',
        paciente_nombre:   'Isaac',
        paciente_hash:     'a1b2c3d4e5f6a7b8',
        tipo_consulta:     'revision_visual',
      },
    }), res);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/paciente_email|paciente_telefono|paciente_nombre/);
  });

  it('T26 · GET response (listado) → sin PII', async () => {
    mocks.setCitasCfg({
      listRows: [
        {
          id: 1, fecha: '2026-06-01', hora: '10:00',
          paciente_hash: 'a1b2c3d4e5f6a7b8',
          estado: 'agendada', tipo_consulta: 'revision_visual',
        },
      ],
      listCount: 1,
    });
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/paciente_email|paciente_telefono|paciente_nombre/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bloque 8 · Headers + Cache-Control
  // ─────────────────────────────────────────────────────────────────────────

  it('T27 · Cache-Control: no-store, max-age=0 en TODAS las responses', async () => {
    const res1 = makeRes();
    await handler(makeReq({ method: 'GET' }), res1);
    expect(res1.headers['Cache-Control']).toBe('no-store, max-age=0');

    const res2 = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { authorization: undefined } }), res2);
    expect(res2.headers['Cache-Control']).toBe('no-store, max-age=0');

    const res3 = makeRes();
    await handler(makeReq({ method: 'GET', headers: { authorization: undefined } }), res3);
    expect(res3.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('T28 · Vary: Origin presente', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.headers['Vary']).toBe('Origin');
  });
});
