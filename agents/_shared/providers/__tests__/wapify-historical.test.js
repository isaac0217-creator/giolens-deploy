/**
 * GIOCORE Frente H — Tests de wapify-historical.ts (sin red real).
 *
 * Verifica:
 *   - bootstrap: paginación full, dedupe entre páginas, completado al llegar a [].
 *   - bootstrap: resume_offset persistido cuando MAX_PAGES_PER_RUN cap.
 *   - delta: filtra por last_seen_updated_at.
 *   - 429: respeta backoff y reintenta hasta MAX_RETRIES.
 *   - Wapify body error (HTTP 200 + {error:{code:...}}): falla con detalle.
 *   - Pipeline protegido (252999 SPY): solo GET, no PATCH/POST.
 *   - WAPIFY_TOKEN ausente: aborta limpio.
 *   - PIPELINES expone los 5 IDs activos.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportWapifyHistorical, PIPELINES } from '../wapify-historical.ts';

function mockResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function makeSupabase(prevState = {}) {
  const calls = { inserts: [], selects: [] };

  return {
    calls,
    client: {
      from(table) {
        if (table !== 'backups_manifest') {
          throw new Error(`Tabla no mockeada: ${table}`);
        }
        return {
          select() {
            const state = { in: {}, eq: {}, filter: [], order: null, limit: null };
            const chain = {
              in(c, arr) { state.in[c] = arr; return chain; },
              eq(c, v) { state.eq[c] = v; return chain; },
              filter(c, op, v) { state.filter.push({ c, op, v }); return chain; },
              order() { return chain; },
              limit(n) { state.limit = n; return chain; },
              maybeSingle() {
                calls.selects.push({ ...state });
                // Devolvemos prevState para el pipeline correspondiente
                const pid = state.filter.find((f) => f.c === 'metadata->>pipeline_id')?.v;
                const ps = prevState[Number(pid)];
                if (!ps) return Promise.resolve({ data: null, error: null });
                return Promise.resolve({
                  data: { id: 999, type: 'wapify_historical', metadata: ps },
                  error: null,
                });
              },
            };
            return chain;
          },
          insert(row) {
            calls.inserts.push(row);
            const chain = {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: { id: 1000 + calls.inserts.length },
                      error: null,
                    });
                  },
                };
              },
              then(resolve, reject) {
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              },
            };
            return chain;
          },
        };
      },
    },
  };
}

const ORIGINAL_TOKEN = process.env.WAPIFY_TOKEN;

describe('providers/wapify-historical.ts — PIPELINES', () => {
  it('expone los 5 pipelines del CLAUDE.md', () => {
    expect(PIPELINES).toHaveLength(5);
    const ids = PIPELINES.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([94103, 216977, 252999, 273944, 755062]);
  });

  it('marca 252999 (SPY) y 273944 (GioVision) como protected', () => {
    const prot = PIPELINES.filter((p) => p.protected).map((p) => p.id).sort();
    expect(prot).toEqual([252999, 273944]);
  });
});

describe('providers/wapify-historical.ts — exportWapifyHistorical', () => {
  beforeEach(() => {
    process.env.WAPIFY_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.WAPIFY_TOKEN;
    else process.env.WAPIFY_TOKEN = ORIGINAL_TOKEN;
    vi.restoreAllMocks();
  });

  it('aborta limpio si WAPIFY_TOKEN no está', async () => {
    delete process.env.WAPIFY_TOKEN;
    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client);
    expect(r.pipelines_processed).toBe(0);
    expect(r.notes.some((n) => /WAPIFY_TOKEN/.test(n))).toBe(true);
  });

  it('rechaza pipeline_id desconocido', async () => {
    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client, { only_pipeline_id: 999 });
    expect(r.pipelines_processed).toBe(0);
    expect(r.notes.some((n) => /999/.test(n))).toBe(true);
  });

  it('bootstrap: pagina hasta lista vacía y marca completed', async () => {
    // 2 páginas con datos, 3era vacía → bootstrap completed
    const calls = { urls: [] };
    global.fetch = vi.fn(async (url) => {
      calls.urls.push(url);
      if (/offset=0&/.test(url)) {
        const opps = Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `O${i}`,
          updated_at: '2026-05-20 10:00:00',
        }));
        return mockResponse({ data: opps });
      }
      if (/offset=100&/.test(url)) {
        const opps = Array.from({ length: 50 }, (_, i) => ({
          id: 100 + i,
          name: `O${100 + i}`,
          updated_at: '2026-05-21 10:00:00',
        }));
        return mockResponse({ data: opps });
      }
      return mockResponse({ data: [] });
    });

    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    expect(r.pipelines_completed).toBe(1);
    const p = r.results[0];
    expect(p.mode).toBe('bootstrap');
    expect(p.bootstrap_completed).toBe(true);
    expect(p.new_opportunities).toBe(150);
    expect(p.resume_offset).toBe(null);
  });

  it('bootstrap: respeta MAX_PAGES_PER_RUN y deja in_progress con resume_offset', async () => {
    // Mock devuelve 100 opps en CADA página (nunca vacía) → cap por max_pages_per_run
    let pageCount = 0;
    global.fetch = vi.fn(async (url) => {
      const offsetMatch = url.match(/offset=(\d+)/);
      const offset = Number(offsetMatch[1]);
      const opps = Array.from({ length: 100 }, (_, i) => ({
        id: offset + i,
        updated_at: '2026-05-20 10:00:00',
      }));
      pageCount += 1;
      return mockResponse({ data: opps });
    });

    const { client, calls } = makeSupabase();
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
      max_pages_per_run: 3,
    });

    expect(pageCount).toBe(3);
    const p = r.results[0];
    expect(p.bootstrap_completed).toBe(false);
    expect(p.status).toBe('in_progress');
    expect(p.resume_offset).toBe(300);
    expect(p.new_opportunities).toBe(300);
    expect(r.pipelines_in_progress).toBe(1);
    // Patch Rectificador: el row insertado debe llevar status='in_progress', no 'completed'.
    expect(calls.inserts[0].status).toBe('in_progress');
    expect(calls.inserts[0].completed_at).toBe(null);
  });

  it('delta: skip insert si no hay opportunities nuevas (no row vacío)', async () => {
    global.fetch = vi.fn(async () =>
      mockResponse({ data: [] }), // todo vacío → delta sin novedades
    );
    const { client, calls } = makeSupabase({
      216977: {
        mode: 'bootstrap',
        bootstrap_completed: true,
        resume_offset: 0,
        total_opportunities: 100,
        last_seen_updated_at: '2026-05-21T00:00:00.000Z',
        known_ids: [],
      },
    });
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    const p = r.results[0];
    expect(p.mode).toBe('delta');
    expect(p.new_opportunities).toBe(0);
    expect(p.manifest_id).toBe(null);
    expect(calls.inserts).toHaveLength(0);
    expect(p.notes.some((n) => /delta vacío/.test(n))).toBe(true);
  });

  it('dedupe entre páginas: mismo id en página 0 y 1 NO duplica', async () => {
    // Cada página debe tener PAGE_LIMIT=100 items para NO disparar "página corta"
    // (early-exit que marca bootstrap_completed sin fetchear la siguiente).
    // Construimos overlap: página 0 = ids 0..99, página 1 = ids 99..198 (99 repetido).
    global.fetch = vi.fn(async (url) => {
      if (/offset=0&/.test(url)) {
        const opps = Array.from({ length: 100 }, (_, i) => ({
          id: i,
          updated_at: '2026-05-20 10:00:00',
        }));
        return mockResponse({ data: opps });
      }
      if (/offset=100&/.test(url)) {
        // Overlap intencional: id 99 aparece otra vez (Wapify quirk)
        const opps = Array.from({ length: 100 }, (_, i) => ({
          id: 99 + i,
          updated_at: '2026-05-20 10:00:00',
        }));
        return mockResponse({ data: opps });
      }
      return mockResponse({ data: [] });
    });

    const { client, calls } = makeSupabase();
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    const p = r.results[0];
    // 100 unique en pág 0 + 99 unique en pág 1 (id 99 deduplicado) = 199
    expect(p.new_opportunities).toBe(199);
    const insertedMetadata = calls.inserts[0].metadata;
    expect(insertedMetadata.known_ids.length).toBe(199);
    // Confirma que el id 99 no se duplicó
    const idCount = insertedMetadata.known_ids.filter((x) => x === 99).length;
    expect(idCount).toBe(1);
  });

  it('delta: si bootstrap_completed → filtra por last_seen_updated_at', async () => {
    global.fetch = vi.fn(async () => {
      return mockResponse({
        data: [
          { id: 1, updated_at: '2026-05-20T10:00:00.000Z' }, // VIEJO (antes de last)
          { id: 2, updated_at: '2026-05-22T10:00:00.000Z' }, // NUEVO
          { id: 3, updated_at: '2026-05-23T10:00:00.000Z' }, // NUEVO
          // página corta → bootstrap end-of-data
        ],
      });
    });

    const { client, calls } = makeSupabase({
      216977: {
        mode: 'bootstrap',
        bootstrap_completed: true,
        resume_offset: 0,
        total_opportunities: 100,
        last_seen_updated_at: '2026-05-21T00:00:00.000Z',
        known_ids: [],
      },
    });
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    const p = r.results[0];
    expect(p.mode).toBe('delta');
    expect(p.new_opportunities).toBe(2); // id 2 y 3 (no 1 que es anterior a last_seen)
    expect(p.last_seen_updated_at).toBe('2026-05-23T10:00:00.000Z');
  });

  it('429 reintenta con Retry-After (mockeado con sleep_ms=0 efectivamente noop)', async () => {
    let attempts = 0;
    global.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) {
        return mockResponse(null, {
          ok: false,
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return mockResponse({ data: [] });
    });

    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(r.pipelines_completed).toBe(1);
  });

  it('Wapify body error (HTTP 200 + {error:{code:...}}) → status=failed con detalle', async () => {
    global.fetch = vi.fn(async () =>
      mockResponse({ error: { code: 404, message: 'pipeline not found' } }),
    );

    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
    });

    const p = r.results[0];
    expect(p.status).toBe('failed');
    expect(p.error).toMatch(/wapify_error/);
    expect(p.error).toMatch(/404/);
  });

  it('procesa los 5 pipelines si no se pasa pipeline_id', async () => {
    global.fetch = vi.fn(async () => mockResponse({ data: [] }));
    const { client } = makeSupabase();
    const r = await exportWapifyHistorical(client, { sleep_ms: 0 });
    expect(r.pipelines_processed).toBe(5);
  });

  it('dry_run no escribe en backups_manifest', async () => {
    global.fetch = vi.fn(async () =>
      mockResponse({ data: [{ id: 1, updated_at: '2026-05-22T10:00:00.000Z' }] }),
    );
    const { client, calls } = makeSupabase();
    await exportWapifyHistorical(client, {
      only_pipeline_id: 216977,
      sleep_ms: 0,
      dry_run: true,
    });
    expect(calls.inserts).toHaveLength(0);
  });

  it('pipeline protegido 252999 (SPY): solo GET (no PATCH/POST en código)', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: [] }));
    global.fetch = fetchMock;
    const { client } = makeSupabase();
    await exportWapifyHistorical(client, {
      only_pipeline_id: 252999,
      sleep_ms: 0,
    });
    // Verifica que TODOS los fetch calls fueron GET
    for (const call of fetchMock.mock.calls) {
      const opts = call[1];
      expect(opts.method ?? 'GET').toBe('GET');
    }
  });
});
