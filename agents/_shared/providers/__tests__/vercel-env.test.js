/**
 * GIOCORE Frente B — tests unit del helper `updateProductionEnvVar`.
 *
 * Mockea `fetch` global. Verifica:
 *   - GET list + PATCH si existe (acción "patched")
 *   - GET list + POST si no existe (acción "created")
 *   - rechazo si VERCEL_TOKEN o VERCEL_PROJECT_ID faltan
 *   - rechazo si value vacío (defensivo: no escribimos secretos vacíos)
 *   - error transport en list / patch / post
 *   - el `value` NUNCA aparece en el resultado devuelto al caller
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateProductionEnvVar } from '../vercel-env.ts';

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('providers/vercel-env.ts — updateProductionEnvVar', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) sin token → success=false sin llamar Vercel', async () => {
    const r = await updateProductionEnvVar('FOO', 'bar', {
      token: '',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/VERCEL_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('(b) sin projectId → success=false sin llamar Vercel', async () => {
    const r = await updateProductionEnvVar('FOO', 'bar', {
      token: 'vrc-tok',
      projectId: '',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/VERCEL_PROJECT_ID/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('(c) value vacío → rechazo defensivo (no escribimos secrets vacíos)', async () => {
    const r = await updateProductionEnvVar('FOO', '', {
      token: 'vrc-tok',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/value vacío/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('(d) var existe → PATCH con action=patched', async () => {
    let callIdx = 0;
    global.fetch = vi.fn(async (url, init) => {
      callIdx++;
      if (callIdx === 1) {
        expect(url).toMatch(/\/v9\/projects\/prj_x\/env/);
        expect(init.method).toBe('GET');
        return jsonRes({
          envs: [
            { id: 'env-id-existing', key: 'META_TOKEN', target: ['production'] },
            { id: 'env-id-other', key: 'SUPABASE_URL', target: ['production'] },
          ],
        });
      }
      // 2nd call: PATCH
      expect(url).toMatch(/\/v10\/projects\/prj_x\/env\/env-id-existing/);
      expect(init.method).toBe('PATCH');
      const body = JSON.parse(init.body);
      expect(body.value).toBe('new-secret-value');
      expect(body.target).toEqual(['production']);
      return jsonRes({ id: 'env-id-existing' });
    });

    const r = await updateProductionEnvVar('META_TOKEN', 'new-secret-value', {
      token: 'vrc-tok',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(true);
    expect(r.action).toBe('patched');
    expect(r.envId).toBe('env-id-existing');
  });

  it('(e) var no existe → POST con action=created', async () => {
    let callIdx = 0;
    global.fetch = vi.fn(async (url, init) => {
      callIdx++;
      if (callIdx === 1) {
        return jsonRes({ envs: [] });
      }
      expect(url).toMatch(/\/v10\/projects\/prj_x\/env$/);
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.key).toBe('NEW_VAR');
      expect(body.value).toBe('val');
      expect(body.target).toEqual(['production']);
      expect(body.type).toBe('encrypted');
      return jsonRes({ key: 'NEW_VAR' });
    });

    const r = await updateProductionEnvVar('NEW_VAR', 'val', {
      token: 'vrc-tok',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(true);
    expect(r.action).toBe('created');
  });

  it('(f) GET list falla HTTP → success=false', async () => {
    global.fetch = vi.fn(async () =>
      jsonRes({ error: 'unauthorized' }, { ok: false, status: 401 }),
    );
    const r = await updateProductionEnvVar('FOO', 'bar', {
      token: 'vrc-bad',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/list HTTP 401/);
  });

  it('(g) PATCH falla HTTP → success=false + envId reportado', async () => {
    let callIdx = 0;
    global.fetch = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return jsonRes({ envs: [{ id: 'env-1', key: 'FOO', target: ['production'] }] });
      }
      return jsonRes({ error: 'forbidden' }, { ok: false, status: 403 });
    });
    const r = await updateProductionEnvVar('FOO', 'newval', {
      token: 'vrc-low-priv',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(false);
    expect(r.envId).toBe('env-1');
    expect(r.error).toMatch(/patch HTTP 403/);
  });

  it('(h) fetch transport falla → success=false con mensaje útil', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const r = await updateProductionEnvVar('FOO', 'bar', {
      token: 'vrc-tok',
      projectId: 'prj_x',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/list fetch falló/);
  });

  it('(i) target custom override default production', async () => {
    let postedBody;
    global.fetch = vi.fn(async (url, init) => {
      if (init.method === 'GET') return jsonRes({ envs: [] });
      postedBody = JSON.parse(init.body);
      return jsonRes({});
    });
    await updateProductionEnvVar('FOO', 'bar', {
      token: 'vrc-tok',
      projectId: 'prj_x',
      target: ['preview', 'development'],
    });
    expect(postedBody.target).toEqual(['preview', 'development']);
  });

  it('(j) resultado nunca incluye el value (seguridad)', async () => {
    global.fetch = vi.fn(async () => jsonRes({ envs: [] }));
    const r = await updateProductionEnvVar('FOO', 'super-secret-value-12345', {
      token: 'vrc-tok',
      projectId: 'prj_x',
    });
    // El value crudo no debe aparecer en ningún campo del resultado.
    expect(JSON.stringify(r)).not.toContain('super-secret-value-12345');
  });
});
