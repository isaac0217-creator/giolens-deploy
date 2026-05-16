/**
 * GioLens — Tool: read_kpis
 * Fase 3 §15. Capa compartida (tools).
 *
 * Disponible para: Analista, Optimizacion, Creativo, QA.
 *
 * Hace GET a /api/pipeline-summary?pipeline_id=X&mode=metrics y retorna
 * el JSON tal cual. Estado: OPERATIVO contra endpoint existente.
 */

const DEFAULT_BASE = process.env.GIOLENS_API_BASE || 'https://giolens-dashboard.vercel.app';

export const toolDefinition = {
  name: 'read_kpis',
  description: 'Lee KPIs de un pipeline (estancamiento >48h, won/lost/active, tasa de cierre). Usar antes de proponer cambios.',
  input_schema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'ID del pipeline Wapify. Ej: 216977 (Justin), 755062 (Sports), 252999 (SpyZ), 94103 (Dama), 273944 (Vision).' },
      all:         { type: 'boolean', description: 'Si true, ignora pipeline_id y agrega los 5 pipelines.' },
    },
  },
};

/**
 * Handler ejecutable.
 * @param {{pipeline_id?:string, all?:boolean}} input
 * @param {{base?:string}} [ctx]
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function handler(input = {}, ctx = {}) {
  const base = ctx.base || DEFAULT_BASE;
  const params = new URLSearchParams({ mode: 'metrics' });
  if (input.all) {
    params.set('all', '1');
  } else if (input.pipeline_id) {
    params.set('pipeline_id', String(input.pipeline_id));
  } else {
    return { ok: false, error: 'pipeline_id o all=true requerido' };
  }
  const url = `${base}/api/pipeline-summary?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} on ${url}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { toolDefinition, handler };
