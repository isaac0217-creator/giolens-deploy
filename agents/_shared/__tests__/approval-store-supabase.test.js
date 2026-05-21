/**
 * GioLens — Frente D · ADR-02 · tests de paridad del approval-store.
 *
 * Cubre los DOS backends del store conmutable:
 *   - IN-MEMORY (isSupabaseReady=false): idempotencia de register() y no-op
 *     del doble resolve(). Es el backend que corre en el entorno de tests por
 *     defecto (sin credenciales Supabase).
 *   - SUPABASE (isSupabaseReady=true, cliente mockeado): verifica que register()
 *     emite un upsert idempotente y resolve() un update condicionado a
 *     status='pending', sin red real.
 *
 * El módulo `./supabase.js` lee env vars en `const` al cargar, así que
 * `isSupabaseReady()` queda fijo al importar. Por eso se mockea el módulo
 * completo con `vi.mock` y cada bloque importa `approval-store.js` fresco vía
 * `vi.resetModules()` + `import()` dinámico.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ───────────────────────────────────────────────────────────────────────────
// Backend IN-MEMORY — supabase.js mockeado a "no listo".
// ───────────────────────────────────────────────────────────────────────────
describe('D · approval-store · backend IN-MEMORY (isSupabaseReady=false)', () => {
  let store;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../supabase.js', () => ({
      isSupabaseReady: () => false,
      getServiceClient: () => null,
    }));
    store = await import('../approval-store.js');
    store._resetForTests();
  });

  it('register() es idempotente: mismo decision_key 2× = una sola entrada', () => {
    const a = store.register({ decision_id: 'idem-1', agent: 'a', action: 'b', amount_usd: 5 });
    const b = store.register({ decision_id: 'idem-1', agent: 'a', action: 'b', amount_usd: 5 });
    expect(b).toBe(a); // devuelve la MISMA referencia existente
    expect(store.getPending().filter((d) => d.decision_id === 'idem-1')).toHaveLength(1);
  });

  it('register() idempotente también si la decisión ya fue resuelta', () => {
    store.register({ decision_id: 'idem-2', agent: 'a', action: 'b' });
    store.resolve('idem-2', { approved: true, by: 'x', at: new Date().toISOString(), decision_id: 'idem-2' });
    const again = store.register({ decision_id: 'idem-2', agent: 'a', action: 'b' });
    expect(again.status).toBe('approved'); // devuelve la resuelta, no una nueva pendiente
    expect(store.getPending()).toHaveLength(0);
  });

  it('doble resolve() es no-op: no duplica historial', () => {
    store.register({ decision_id: 'noop-1', agent: 'a', action: 'b' });
    const v = { approved: true, by: 'x', at: new Date().toISOString(), decision_id: 'noop-1' };
    const first = store.resolve('noop-1', v);
    const second = store.resolve('noop-1', v);
    expect(first.decision_id).toBe('noop-1');
    expect(second).toBe(first); // segundo resolve devuelve la fila ya resuelta
    expect(store.getHistory().filter((h) => h.decision_id === 'noop-1')).toHaveLength(1);
  });

  it('resolve() de una decisión inexistente devuelve null sin lanzar', () => {
    expect(store.resolve('nunca-existió', { approved: false })).toBeNull();
  });

  it('register() persiste correlation_id en el registro del store', () => {
    const rec = store.register({ decision_id: 'corr-1', agent: 'a', action: 'b', correlation_id: 'run-xyz' });
    expect(rec.correlation_id).toBe('run-xyz');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Backend SUPABASE — cliente mockeado (sin red). Verifica que el store emite
// las operaciones correctas contra `agent_decisions`.
// ───────────────────────────────────────────────────────────────────────────
describe('D · approval-store · backend SUPABASE (cliente mockeado)', () => {
  let store;
  let calls;

  /**
   * Construye un mock encadenable del query builder de supabase-js.
   * Registra cada operación en `calls` para aserciones.
   */
  function makeClient() {
    calls = { upserts: [], updates: [] };
    return {
      from(table) {
        return {
          upsert(row, opts) {
            calls.upserts.push({ table, row, opts });
            return Promise.resolve({ data: [row], error: null });
          },
          update(patch) {
            const u = { table, patch, filters: {} };
            calls.updates.push(u);
            const chain = {
              eq(col, val) { u.filters[col] = val; return chain; },
              then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
            };
            return chain;
          },
        };
      },
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    const client = makeClient();
    vi.doMock('../supabase.js', () => ({
      isSupabaseReady: () => true,
      getServiceClient: () => client,
    }));
    store = await import('../approval-store.js');
    store._resetForTests();
  });

  it('register() emite un upsert idempotente a agent_decisions', async () => {
    store.register({
      decision_id: 'sb-reg-1', agent: 'optimizacion', action: 'increase_budget',
      rationale: 'cpr bajo', evidence: { cpr: 1.2 }, amount_usd: 200, correlation_id: 'run-1',
    });
    // la persistencia es fire-and-forget — esperar a la microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.upserts).toHaveLength(1);
    const { table, row, opts } = calls.upserts[0];
    expect(table).toBe('agent_decisions');
    expect(opts).toEqual({ onConflict: 'decision_key', ignoreDuplicates: true });
    expect(row.decision_key).toBe('sb-reg-1');
    expect(row.agent_name).toBe('optimizacion');
    expect(row.decision_type).toBe('increase_budget');
    expect(row.justification).toBe('cpr bajo');
    expect(row.evidence_refs).toEqual({ cpr: 1.2 });
    expect(row.amount_usd).toBe(200);
    expect(row.correlation_id).toBe('run-1');
    expect(row.status).toBe('pending');
  });

  it('register() idempotente: segundo register del mismo decision_key NO re-emite upsert', async () => {
    store.register({ decision_id: 'sb-reg-2', agent: 'a', action: 'b' });
    store.register({ decision_id: 'sb-reg-2', agent: 'a', action: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    // el segundo register corta en el guard de idempotencia in-process
    expect(calls.upserts).toHaveLength(1);
  });

  it('resolve() humano emite update condicionado a status=pending con verdict', async () => {
    store.register({ decision_id: 'sb-res-1', agent: 'a', action: 'b' });
    const verdict = { approved: true, by: 'isaac', at: new Date().toISOString(), decision_id: 'sb-res-1', note: 'ok' };
    store.resolve('sb-res-1', verdict);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.updates).toHaveLength(1);
    const { table, patch, filters } = calls.updates[0];
    expect(table).toBe('agent_decisions');
    expect(patch.status).toBe('approved');
    expect(patch.verdict).toEqual(verdict);
    expect(patch.resolved_at).toBeTruthy();
    expect(filters).toEqual({ decision_key: 'sb-res-1', status: 'pending' });
  });

  it('resolve() mapea status: timeout→expired, auto→auto_approved, rechazo→rejected', async () => {
    store.register({ decision_id: 'sb-to', agent: 'a', action: 'b' });
    store.resolve('sb-to', { approved: false, by: 'timeout', decision_id: 'sb-to' });
    store.register({ decision_id: 'sb-auto', agent: 'a', action: 'b' });
    store.resolve('sb-auto', { approved: true, by: 'auto-mode', decision_id: 'sb-auto' });
    store.register({ decision_id: 'sb-rej', agent: 'a', action: 'b' });
    store.resolve('sb-rej', { approved: false, by: 'isaac', decision_id: 'sb-rej' });
    await new Promise((r) => setTimeout(r, 0));

    const byKey = Object.fromEntries(calls.updates.map((u) => [u.filters.decision_key, u.patch.status]));
    expect(byKey['sb-to']).toBe('expired');
    expect(byKey['sb-auto']).toBe('auto_approved');
    expect(byKey['sb-rej']).toBe('rejected');
  });

  it('doble resolve() emite a lo sumo un update (segundo es no-op in-process)', async () => {
    store.register({ decision_id: 'sb-dbl', agent: 'a', action: 'b' });
    const v = { approved: true, by: 'isaac', at: new Date().toISOString(), decision_id: 'sb-dbl' };
    store.resolve('sb-dbl', v);
    store.resolve('sb-dbl', v);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.updates).toHaveLength(1);
  });
});
