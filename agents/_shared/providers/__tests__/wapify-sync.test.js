/**
 * GIOCORE Frente D.2 — tests unit de syncWapifyCache (sin red ni DB real).
 *
 * Mockea `fetch` global + cliente Supabase (objeto plano con tracker).
 * Verifica: shape de PipelineSyncResult, dry_run no escribe, upsert por id,
 * pipelines protegidos siguen siendo leídos (read-only allowed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { syncWapifyCache, PIPELINES } from '../wapify-sync.ts';

function mockResponse(body, { ok = true, status = 200, json = true } = {}) {
  return {
    ok,
    status,
    json: json
      ? async () => body
      : async () => {
          throw new Error('no-JSON');
        },
  };
}

/** Construye un cliente Supabase mock con tracker de operaciones. */
function makeSupabaseMock() {
  const calls = {
    knowledgeReads: [], // {category, key}
    knowledgeDeletes: [], // {category, key}
    knowledgeInserts: [], // row
    contactUpserts: [], // {rows, options}
    decisionInserts: [], // row
  };

  // Devolvemos un cliente con .from() que dispatchea según la tabla.
  const client = {
    from(table) {
      if (table === 'knowledge_base') {
        return {
          select(_cols) {
            return {
              eq(col, val) {
                this._eq = { ...(this._eq ?? {}), [col]: val };
                return this;
              },
              maybeSingle() {
                calls.knowledgeReads.push(this._eq);
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
          delete() {
            return {
              eq(col, val) {
                this._eq = { ...(this._eq ?? {}), [col]: val };
                return this;
              },
              then(resolve) {
                calls.knowledgeDeletes.push(this._eq);
                resolve({ data: null, error: null });
              },
            };
          },
          insert(row) {
            calls.knowledgeInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === 'contacts') {
        return {
          upsert(rows, options) {
            calls.contactUpserts.push({ rows, options });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === 'agent_decisions') {
        return {
          insert(row) {
            calls.decisionInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
          upsert(row) {
            calls.decisionInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Tabla no mockeada: ${table}`);
    },
  };
  return { client, calls };
}

const ORIGINAL_TOKEN = process.env.WAPIFY_TOKEN;

describe('providers/wapify-sync.ts — PIPELINES', () => {
  it('expone los 5 pipelines activos', () => {
    expect(PIPELINES).toHaveLength(5);
    const ids = PIPELINES.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([94103, 216977, 252999, 273944, 755062]);
  });

  it('marca 252999 (SPY) y 273944 (GioVision) como protected', () => {
    const protectedIds = PIPELINES.filter((p) => p.protected).map((p) => p.id).sort();
    expect(protectedIds).toEqual([252999, 273944]);
  });
});

describe('providers/wapify-sync.ts — syncWapifyCache', () => {
  beforeEach(() => {
    process.env.WAPIFY_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.WAPIFY_TOKEN;
    else process.env.WAPIFY_TOKEN = ORIGINAL_TOKEN;
    vi.restoreAllMocks();
  });

  it('lanza si falta WAPIFY_TOKEN', async () => {
    delete process.env.WAPIFY_TOKEN;
    const { client } = makeSupabaseMock();
    await expect(syncWapifyCache(client)).rejects.toThrow(/WAPIFY_TOKEN/);
  });

  it('procesa solo el pipeline_id pedido', async () => {
    global.fetch = vi.fn(async () => mockResponse({ data: [] }));
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });

    expect(results).toHaveLength(1);
    expect(results[0].pipeline_id).toBe(216977);
  });

  it('rechaza pipeline_id desconocido', async () => {
    const { client } = makeSupabaseMock();
    await expect(syncWapifyCache(client, { pipeline_id: 999999 })).rejects.toThrow(/999999/);
  });

  it('procesa los 5 pipelines si no se pasa pipeline_id', async () => {
    global.fetch = vi.fn(async () => mockResponse({ data: [] }));
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { dry_run: true });
    expect(results).toHaveLength(5);
    const ids = results.map((r) => r.pipeline_id).sort((a, b) => a - b);
    expect(ids).toEqual([94103, 216977, 252999, 273944, 755062]);
  });

  it('dry_run=true no escribe en contacts ni en knowledge_base', async () => {
    const contact = { id: 1, name: 'A', pipeline_id: 216977 };
    global.fetch = vi.fn(async () => mockResponse({ data: [contact] }));
    const { client, calls } = makeSupabaseMock();

    const results = await syncWapifyCache(client, {
      pipeline_id: 216977,
      dry_run: true,
    });

    expect(results[0].contacts_fetched).toBe(1);
    expect(results[0].contacts_upserted).toBe(0);
    expect(results[0].dry_run).toBe(true);
    expect(calls.contactUpserts).toHaveLength(0);
    expect(calls.knowledgeInserts).toHaveLength(0);
  });

  it('NON-dry_run upsertea contacts y actualiza sync_state', async () => {
    const contact = {
      id: 42,
      name: 'Juan',
      phone: '+52',
      email: 'a@b.com',
      stage_name: 'Cierre',
      last_message: 'hola',
      last_message_at: '2026-05-20T10:00:00Z',
    };
    global.fetch = vi.fn(async () => mockResponse({ data: [contact] }));
    const { client, calls } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977 });

    expect(results[0].contacts_upserted).toBe(1);
    expect(calls.contactUpserts).toHaveLength(1);
    expect(calls.contactUpserts[0].options).toMatchObject({ onConflict: 'id' });
    const upsertedRow = calls.contactUpserts[0].rows[0];
    expect(upsertedRow.id).toBe(42);
    expect(upsertedRow.pipeline_id).toBe(216977);
    expect(upsertedRow.stage_phase).toBe('closing');
    expect(calls.knowledgeInserts).toHaveLength(1);
    expect(calls.knowledgeInserts[0].category).toBe('wapify_sync_state');
    expect(calls.knowledgeInserts[0].key).toBe('pipeline_216977');
  });

  it('pasa header X-ACCESS-TOKEN en cada request', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: [] }));
    global.fetch = fetchMock;
    const { client } = makeSupabaseMock();

    await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-ACCESS-TOKEN']).toBe('test-token');
  });

  it('lee pipelines protegidos (252999, 273944) — read-only OK', async () => {
    global.fetch = vi.fn(async () => mockResponse({ data: [{ id: 1 }] }));
    const { client, calls } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 252999, dry_run: true });
    expect(results[0].pipeline_id).toBe(252999);
    expect(results[0].contacts_fetched).toBe(1);
    // Dry-run: no escribe en contacts → no mutación.
    expect(calls.contactUpserts).toHaveLength(0);
  });

  it('paginación: suma páginas hasta que una sea incompleta', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const partial = Array.from({ length: 7 }, (_, i) => ({ id: 1000 + i }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ data: full }))
      .mockResolvedValueOnce(mockResponse({ data: partial }));
    global.fetch = fetchMock;
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[0].contacts_fetched).toBe(107);
    expect(results[0].pages_fetched).toBe(2);
  });

  it('HTTP no-OK degrada con nota (no lanza, sigue con siguientes pipelines)', async () => {
    global.fetch = vi.fn(async () => mockResponse(null, { ok: false, status: 500 }));
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });
    expect(results[0].contacts_fetched).toBe(0);
    expect(results[0].notes.some((n) => n.includes('500'))).toBe(true);
  });

  it('body no-JSON → nota explícita, no lanza', async () => {
    global.fetch = vi.fn(async () => mockResponse(null, { json: false }));
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });
    expect(results[0].notes.some((n) => n.includes('no-JSON'))).toBe(true);
  });

  it('error-object de Wapify (HTTP 200 con {"error":{}}) → nota', async () => {
    global.fetch = vi.fn(async () =>
      mockResponse({ error: { code: 404, message: 'no existe' } }),
    );
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });
    expect(results[0].notes.some((n) => n.includes('error'))).toBe(true);
  });

  it('payload con shape irreconocible → nota', async () => {
    global.fetch = vi.fn(async () => mockResponse({ unexpected: 'shape' }));
    const { client } = makeSupabaseMock();

    const results = await syncWapifyCache(client, { pipeline_id: 216977, dry_run: true });
    expect(results[0].notes.some((n) => n.includes('Shape'))).toBe(true);
  });
});
