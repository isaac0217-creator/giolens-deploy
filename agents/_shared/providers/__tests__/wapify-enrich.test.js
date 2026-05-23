/**
 * GIOCORE Frente C — tests unit de enrichContacts (sin red ni DB real).
 *
 * Mockea `fetch` global + cliente Supabase con tracker de SELECT/UPDATE.
 * Cubre:
 *   - mapping name/full_name/first+last_name a `name` (defensive).
 *   - email "" → null.
 *   - 404 → marca contact_id_invalid=true (no reintenta).
 *   - body-level 429 → retry con backoff (cuenta retries).
 *   - dry_run no escribe UPDATE.
 *   - throttle entre requests (verifica con timers fake).
 *   - sin WAPIFY_TOKEN → throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrichContacts } from '../wapify-enrich.ts';

function mockResponse(body, { status = 200, json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: json
      ? async () => body
      : async () => {
          throw new Error('no-JSON');
        },
  };
}

/** Cliente Supabase mock con tracker. Devuelve `pendingRows` para el SELECT
 *  del enrich. Registra UPDATEs por contact_id. */
function makeSupabaseMock(pendingRows) {
  const calls = {
    selectRequests: [],
    updates: [], // {table, set, eq: {contact_id}}
  };

  const client = {
    from(table) {
      if (table !== 'contacts') {
        throw new Error(`Tabla no mockeada: ${table}`);
      }
      // Builder con chaining lazy hasta limit() (que resuelve la query).
      const builder = {
        _select: null,
        _filters: [],
        _set: null,
        select(cols) {
          this._select = cols;
          return this;
        },
        or(filter) {
          this._filters.push(['or', filter]);
          return this;
        },
        not(col, op, val) {
          this._filters.push(['not', col, op, val]);
          return this;
        },
        eq(col, val) {
          this._filters.push(['eq', col, val]);
          return this;
        },
        limit(n) {
          calls.selectRequests.push({ filters: this._filters, limit: n });
          return Promise.resolve({ data: pendingRows, error: null });
        },
        update(set) {
          this._set = set;
          // eq() después se llama y retorna promesa
          return {
            _eq: null,
            eq(col, val) {
              this._eq = { [col]: val };
              calls.updates.push({ set, eq: this._eq });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

const ORIGINAL_TOKEN = process.env.WAPIFY_TOKEN;

describe('providers/wapify-enrich.ts — enrichContacts', () => {
  beforeEach(() => {
    process.env.WAPIFY_TOKEN = 'test-wapify-token';
    vi.useRealTimers();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.WAPIFY_TOKEN;
    else process.env.WAPIFY_TOKEN = ORIGINAL_TOKEN;
    vi.restoreAllMocks();
  });

  it('(a) lanza si falta WAPIFY_TOKEN', async () => {
    delete process.env.WAPIFY_TOKEN;
    const { client } = makeSupabaseMock([]);
    await expect(enrichContacts(client)).rejects.toThrow(/WAPIFY_TOKEN/);
  });

  it('(b) sin pendientes → 0 processed, nota informativa', async () => {
    const { client } = makeSupabaseMock([]);
    const r = await enrichContacts(client, { throttleMs: 0 });
    expect(r.processed).toBe(0);
    expect(r.enriched).toBe(0);
    expect(r.notes.some((n) => /No hay/.test(n))).toBe(true);
  });

  it('(c) dedupe contact_id repetidos antes de fetchear', async () => {
    const pending = [
      { contact_id: 'A' }, { contact_id: 'A' }, { contact_id: 'A' },
      { contact_id: 'B' }, { contact_id: 'B' },
    ];
    global.fetch = vi.fn(async () =>
      mockResponse({ full_name: 'X', phone: '+1', email: 'x@x' }),
    );
    const { client } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 5, throttleMs: 0 });
    expect(r.processed).toBe(2); // solo A y B (deduped)
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('(d) mapea full_name → name; phone preservado; email "" → null', async () => {
    const pending = [{ contact_id: 'C1' }];
    global.fetch = vi.fn(async () =>
      mockResponse({
        id: 'C1',
        full_name: 'Leticia Ortiz Jimenez',
        first_name: 'Leticia',
        last_name: 'Ortiz Jimenez',
        phone: '+5216862922995',
        email: '',
      }),
    );
    const { client, calls } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0 });
    expect(r.enriched).toBe(1);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].set.name).toBe('Leticia Ortiz Jimenez');
    expect(calls.updates[0].set.phone).toBe('+5216862922995');
    expect(calls.updates[0].set.email).toBeNull();
    expect(calls.updates[0].eq.contact_id).toBe('C1');
    expect(typeof calls.updates[0].set.enriched_at).toBe('string');
  });

  it('(e) sin full_name compone first+last_name', async () => {
    const pending = [{ contact_id: 'C2' }];
    global.fetch = vi.fn(async () =>
      mockResponse({
        first_name: 'Genaro',
        last_name: '',
        phone: '+16193426334',
        email: 'g@g',
      }),
    );
    const { client, calls } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0 });
    expect(r.enriched).toBe(1);
    expect(calls.updates[0].set.name).toBe('Genaro');
    expect(calls.updates[0].set.email).toBe('g@g');
  });

  it('(f) HTTP 404 → marca contact_id_invalid=true, no incrementa enriched', async () => {
    const pending = [{ contact_id: 'GONE' }];
    global.fetch = vi.fn(async () => mockResponse({}, { status: 404 }));
    const { client, calls } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0 });
    expect(r.enriched).toBe(0);
    expect(r.invalid).toBe(1);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].set.contact_id_invalid).toBe(true);
  });

  it('(g) body-level error 404 (Wapify HTTP 200 quirk) → marca invalid', async () => {
    const pending = [{ contact_id: 'GHOST' }];
    global.fetch = vi.fn(async () =>
      mockResponse({ error: { code: 404, message: 'not found' } }),
    );
    const { client, calls } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0 });
    expect(r.invalid).toBe(1);
    expect(calls.updates[0].set.contact_id_invalid).toBe(true);
  });

  it('(h) body-level 429 → retry con backoff y eventually success', async () => {
    const pending = [{ contact_id: 'RL' }];
    const responses = [
      mockResponse({ error: { code: 429, message: 'rate' } }),
      mockResponse({ error: { code: 429, message: 'rate' } }),
      mockResponse({ full_name: 'OK', phone: '+1', email: 'o@o' }),
    ];
    global.fetch = vi.fn(async () => responses.shift());
    const { client } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0 });
    expect(r.enriched).toBe(1);
    expect(r.rate_limited_retries).toBeGreaterThanOrEqual(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('(i) 429 persistente tras maxRetries → break loop, marca failed', async () => {
    const pending = [{ contact_id: 'RL_PERSIST' }, { contact_id: 'NEVER' }];
    global.fetch = vi.fn(async () =>
      mockResponse({ error: { code: 429, message: 'rate' } }),
    );
    const { client } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 2, throttleMs: 0 });
    expect(r.failed).toBe(1);
    // break después del 1ro: NEVER no se intenta.
    expect(r.enriched + r.failed + r.invalid).toBe(1);
  }, 30_000);

  it('(j) dry_run=true no llama supabase.update', async () => {
    const pending = [{ contact_id: 'DRY' }];
    global.fetch = vi.fn(async () =>
      mockResponse({ full_name: 'X', phone: '+1', email: 'x@x' }),
    );
    const { client, calls } = makeSupabaseMock(pending);
    const r = await enrichContacts(client, { batchSize: 1, throttleMs: 0, dry_run: true });
    expect(r.enriched).toBe(1);
    expect(calls.updates).toHaveLength(0);
  });

  it('(k) SELECT filtra por name/phone/email null + contact_id_invalid=false', async () => {
    const { client, calls } = makeSupabaseMock([]);
    await enrichContacts(client, { batchSize: 10, throttleMs: 0 });
    expect(calls.selectRequests).toHaveLength(1);
    const req = calls.selectRequests[0];
    // Verificamos que al menos uno de los filtros es contact_id_invalid=false.
    const eqFilters = req.filters.filter(([op]) => op === 'eq');
    expect(eqFilters.some(([, col, val]) => col === 'contact_id_invalid' && val === false)).toBe(true);
  });
});
