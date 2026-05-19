/**
 * GioLens — Tool: read_pipeline
 * Fase 3 §15. Capa compartida (tools).
 *
 * Disponible para: Analista, Optimizacion, Creativo, QA.
 *
 * GET /api/pipeline-summary?pipeline_id=X (modo estandar = stage counts;
 * modo journey opcional = Int1/2/3, cierre, won, lost). Estado: OPERATIVO.
 */

const DEFAULT_BASE = process.env.GIOLENS_API_BASE || 'https://giolens-dashboard.vercel.app';

export const toolDefinition = {
  name: 'read_pipeline',
  description: 'Lee conteo de leads por etapa de un pipeline. Modo journey opcional mapea cada lead a Int1/Int2/Int3/Cierre/Won/Lost.',
  input_schema: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'ID del pipeline Wapify.' },
      mode:        { type: 'string', enum: ['standard', 'journey'], description: 'standard=stage counts (default); journey=interaccion mapping.' },
    },
    required: ['pipeline_id'],
  },
};

/**
 * @param {{pipeline_id:string, mode?:'standard'|'journey'}} input
 * @param {{base?:string}} [ctx]
 */
export async function handler(input = {}, ctx = {}) {
  if (!input.pipeline_id) return { ok: false, error: 'pipeline_id requerido' };
  const base = ctx.base || DEFAULT_BASE;
  const params = new URLSearchParams({ pipeline_id: String(input.pipeline_id) });
  if (input.mode === 'journey') params.set('mode', 'journey');
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

// Default export es la función handler con props .toolDefinition y .handler
// para permitir tanto `await readPipeline(input)` (función) como `readPipeline.handler(...)`
// y `readPipeline.toolDefinition`. Cierra P0-2 / R-19 BIS (audit 18 may PM tardío).
handler.toolDefinition = toolDefinition;
handler.handler = handler;
export default handler;
