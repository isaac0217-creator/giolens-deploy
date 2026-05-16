/**
 * GioLens — rollback.js tests (Vitest)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { register, has, executeRollback, _resetForTests } from '../rollback.js';

describe('rollback.js — registry & execute', () => {
  beforeEach(() => _resetForTests());

  it('handlers default estan registrados tras reset', () => {
    expect(has('ad_published')).toBe(true);
    expect(has('lead_stage_moved')).toBe(true);
    expect(has('budget_changed')).toBe(true);
  });

  it('register agrega un kind nuevo y executeRollback lo invoca', async () => {
    let called = null;
    register('test_kind', async (payload) => {
      called = payload;
      return { ok: true, detail: 'reverted' };
    });
    const res = await executeRollback({ kind: 'test_kind', payload: { x: 42 } });
    expect(called).toEqual({ x: 42 });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('test_kind');
    expect(res.detail).toBe('reverted');
  });

  it('executeRollback con kind desconocido devuelve ok:false', async () => {
    const res = await executeRollback({ kind: 'no_existe' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no handler/);
  });

  it('executeRollback sin decision_action.kind devuelve ok:false', async () => {
    const res = await executeRollback({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/kind missing/);
  });

  it('handler que throwea se captura y devuelve ok:false con error', async () => {
    register('boom', async () => { throw new Error('explosion'); });
    const res = await executeRollback({ kind: 'boom' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('explosion');
  });

  it('handler que retorna ok:false propaga error', async () => {
    register('fail', async () => ({ ok: false, error: 'api down' }));
    const res = await executeRollback({ kind: 'fail' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('api down');
  });

  it('register reemplaza handler previo', async () => {
    register('dup', async () => ({ ok: true, detail: 'first' }));
    register('dup', async () => ({ ok: true, detail: 'second' }));
    const res = await executeRollback({ kind: 'dup' });
    expect(res.detail).toBe('second');
  });

  it('default ad_published handler corre sin throw (stub)', async () => {
    const res = await executeRollback({ kind: 'ad_published', payload: { ad_id: 'X' } });
    expect(res.ok).toBe(true);
  });
});
