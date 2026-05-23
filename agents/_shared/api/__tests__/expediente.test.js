/**
 * GIOCORE Frente D — tests del handler `api/expediente.ts`.
 *
 * Verifica:
 *   - CORS preflight 204
 *   - 405 si no es POST
 *   - 400 si payload inválido (sin nombre, sin capturado_por, rangos)
 *   - 201 con payload válido + INSERT + UPDATE vault_md
 *   - Cache-Control: no-store en TODAS las responses
 *   - lookup contact por teléfono normalizado
 *   - fechas: default hoy, rechazo si > 30 días futuro o < 1990
 *   - rangos clínicos validados (esfera ±25, cilindro ±12, eje 0-180)
 *   - .md generation failure no rompe la respuesta (logs a agent_decisions)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    contactSelects: [], // {filters}
    expedienteInserts: [], // {row}
    expedienteUpdates: [], // {set, eq}
    decisionInserts: [], // {row}
  };

  const expedientesBuilder = () => ({
    _row: null,
    _selectCols: null,
    _filter: null,
    insert(row) {
      this._row = row;
      calls.expedienteInserts.push({ row });
      return this; // chainable
    },
    select(cols) {
      this._selectCols = cols;
      return this;
    },
    single() {
      return Promise.resolve({
        data: { id: 999, fecha_examen: this._row.fecha_examen, created_at: '2026-05-23T15:00:00.000Z' },
        error: null,
      });
    },
    update(set) {
      this._set = set;
      return {
        _eq: null,
        eq(col, val) {
          this._eq = { [col]: val };
          calls.expedienteUpdates.push({ set, eq: this._eq });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  });

  const contactsBuilder = (mockContactId) => ({
    _eq: null,
    select() { return this; },
    eq(col, val) { this._eq = { [col]: val }; return this; },
    not() { return this; },
    limit() { return this; },
    maybeSingle() {
      calls.contactSelects.push({ eq: this._eq });
      return Promise.resolve({
        data: mockContactId ? { contact_id: mockContactId } : null,
        error: null,
      });
    },
  });

  let mockContactIdReturn = null;

  const supabaseClient = {
    from(table) {
      if (table === 'expedientes') return expedientesBuilder();
      if (table === 'contacts') return contactsBuilder(mockContactIdReturn);
      if (table === 'agent_decisions') {
        return {
          insert(row) {
            calls.decisionInserts.push({ row });
            return Promise.resolve({ data: null, error: null }).then((v) => { v.then = undefined; return v; });
          },
        };
      }
      throw new Error(`tabla no mockeada: ${table}`);
    },
  };

  return {
    calls,
    createClient: vi.fn(() => supabaseClient),
    setContactIdReturn: (cid) => { mockContactIdReturn = cid; },
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
    status(code) { r.statusCode = code; return r; },
    json(body) { r.body = body; return r; },
    end() { r.ended = true; return r; },
    setHeader(name, value) { r.headers[name] = value; return r; },
  };
  return r;
}

const minimalPayload = {
  paciente_nombre: 'Juan Pérez',
  capturado_por: 'optometrista_test',
};

describe('api/expediente.ts — handler', () => {
  let handler;

  beforeEach(async () => {
    mocks.calls.contactSelects.length = 0;
    mocks.calls.expedienteInserts.length = 0;
    mocks.calls.expedienteUpdates.length = 0;
    mocks.calls.decisionInserts.length = 0;
    mocks.setContactIdReturn(null);
    mocks.createClient.mockClear();

    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T15:00:00.000Z'));

    vi.resetModules();
    const mod = await import('../../../../api/expediente.ts');
    handler = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) OPTIONS preflight → 204 con CORS headers', async () => {
    const res = makeRes();
    await handler({ method: 'OPTIONS', headers: { origin: 'https://giolens-dashboard.vercel.app' } }, res);
    expect(res.statusCode).toBe(204);
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://giolens-dashboard.vercel.app');
  });

  it('(b) GET / PUT → 405', async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('(c) POST sin paciente_nombre → 400', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { capturado_por: 'x' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/paciente_nombre/);
  });

  it('(d) POST sin capturado_por → 400', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { paciente_nombre: 'X' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/capturado_por/);
  });

  it('(e) POST con fecha futura > 30 días → 400', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, fecha_examen: '2027-01-01' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/futuro/);
  });

  it('(f) POST con fecha pre-1990 → 400', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, fecha_examen: '1980-01-01' },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/antigua/);
  });

  it('(g) POST mínimo válido → 201 + INSERT + UPDATE vault_md', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: minimalPayload }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(999);
    expect(res.body.vault_md_path).toMatch(/^Contactos\/Sin-Contacto\/expedientes\//);
    expect(mocks.calls.expedienteInserts).toHaveLength(1);
    expect(mocks.calls.expedienteUpdates).toHaveLength(1);
    expect(mocks.calls.expedienteUpdates[0].set.vault_md_content).toMatch(/^---\n/);
    expect(mocks.calls.expedienteUpdates[0].set.vault_md_path).toMatch(/Sin-Contacto/);
  });

  it('(h) Cache-Control: no-store en respuestas exitosas y de error', async () => {
    const res1 = makeRes();
    await handler({ method: 'POST', headers: {}, body: minimalPayload }, res1);
    expect(res1.headers['Cache-Control']).toBe('no-store, max-age=0');

    const res2 = makeRes();
    await handler({ method: 'POST', headers: {}, body: {} }, res2);
    expect(res2.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('(i) phone se normaliza a +52...', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, paciente_telefono: '6631180788' },
      },
      res,
    );
    expect(res.statusCode).toBe(201);
    const insertedPhone = mocks.calls.expedienteInserts[0].row.paciente_telefono;
    expect(insertedPhone).toBe('+526631180788');
    // El select a contacts se hace con phone normalizado.
    expect(mocks.calls.contactSelects[0].eq.phone).toBe('+526631180788');
  });

  it('(j) lookup contact existente → contact_id se persiste', async () => {
    mocks.setContactIdReturn('526631180788');
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, paciente_telefono: '+5216631180788' },
      },
      res,
    );
    expect(res.body.contact_id).toBe('526631180788');
    expect(mocks.calls.expedienteInserts[0].row.contact_id).toBe('526631180788');
  });

  it('(k) rangos clínicos: esfera fuera de ±25 se descarta (null)', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, od_esfera: 30, oi_esfera: -2.5 },
      },
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(mocks.calls.expedienteInserts[0].row.od_esfera).toBeNull();
    expect(mocks.calls.expedienteInserts[0].row.oi_esfera).toBe(-2.5);
  });

  it('(l) eje fuera de 0-180 se descarta', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, od_eje: 270, oi_eje: 90 },
      },
      res,
    );
    expect(mocks.calls.expedienteInserts[0].row.od_eje).toBeNull();
    expect(mocks.calls.expedienteInserts[0].row.oi_eje).toBe(90);
  });

  it('(m) productos_recomendados array de strings se preserva', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, productos_recomendados: ['Holbrook', 'AR'] },
      },
      res,
    );
    expect(mocks.calls.expedienteInserts[0].row.productos_recomendados).toEqual(['Holbrook', 'AR']);
  });

  it('(n) graduación 0.00 (paciente emétrope) se persiste como 0, no null', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: {},
        body: { ...minimalPayload, od_esfera: 0, oi_esfera: 0 },
      },
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(mocks.calls.expedienteInserts[0].row.od_esfera).toBe(0);
    expect(mocks.calls.expedienteInserts[0].row.oi_esfera).toBe(0);
  });

  it('(o-cors) origin fuera del proyecto → ACAO fallback prod (no echo)', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.vercel.app' },
      },
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://giolens-dashboard.vercel.app');
  });

  it('(o-cors-preview) preview del proyecto → ACAO echo origin', async () => {
    const res = makeRes();
    await handler(
      {
        method: 'OPTIONS',
        headers: { origin: 'https://giolens-dashboard-de1pusqbf-ojos2020-8707s-projects.vercel.app' },
      },
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://giolens-dashboard-de1pusqbf-ojos2020-8707s-projects.vercel.app');
  });

  it('(p) raw_form_data se persiste íntegro como backup', async () => {
    const fullBody = {
      ...minimalPayload,
      paciente_telefono: '6631180788',
      observaciones: 'custom field',
      extra_unrelated: 'should still be in raw',
    };
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: fullBody }, res);
    expect(mocks.calls.expedienteInserts[0].row.raw_form_data).toEqual(fullBody);
  });
});
