/**
 * GioLens — Tool: get_cpr_table
 * Fase 3 §15. Capa compartida (tools).
 *
 * Disponible para: Creativo (y cualquier agente que razone sobre CPR).
 *
 * Devuelve el CPR (costo por resultado) vigente de un pipeline. Reemplaza
 * los CPRs hardcoded que vivían en el prompt del Creativo (delta B2 · D1
 * Chat 19 may).
 *
 * Estado: STUB Fase 1. Los valores son los CPRs base conocidos al 18 may
 * 2026 — `cpr_source: 'fallback_static'`. NO consulta Meta Ads en vivo.
 *
 * TODO Fase 2 (Frente C / shadow): leer CPR dinámico real desde
 *   - Meta Ads insights (`/api/meta?level=campaign`) por ventana móvil 7d, o
 *   - tabla Supabase `gl_timeseries` cuando tenga >=7 días de histórico.
 *   Cuando la fuente dinámica esté cableada, devolver `cpr_source: 'dynamic'`.
 *   El Creativo declara el `cpr_source` en su output; el Orquestador audita
 *   cada `fallback_static` como signal de degradación.
 */

// CPRs base conocidos al 18 may 2026 (MXN). Fuente: portafolio Meta act_299921604429631.
// Estos son el FALLBACK estático — se usan hasta que la fuente dinámica esté viva.
const CPR_FALLBACK = {
  '216977': { cpr: 8.64,  name: 'Justin · Holbrook · Litebeam' },
  '755062': { cpr: 10.29, name: 'GioSports · Deportivo' },
  '252999': { cpr: 15.20, name: 'SPY · Seguridad Z87' },
  '94103':  { cpr: 23.53, name: 'Dama · Luxury' },
  '273944': { cpr: 27.78, name: 'GioVision · Entintados' },
};

export const toolDefinition = {
  name: 'get_cpr_table',
  description:
    'Lee el CPR (costo por resultado, en MXN) vigente de un pipeline GioLens. ' +
    'Devuelve { cpr, cpr_source }. cpr_source="fallback_static" en Fase 1 — ' +
    'el Creativo debe declarar ese valor en su output. NUNCA cites un CPR de memoria.',
  input_schema: {
    type: 'object',
    properties: {
      pipeline_id: {
        type: 'string',
        description: 'Uno de: 216977, 755062, 252999, 94103, 273944. Omitir para tabla completa.',
      },
    },
  },
};

/**
 * Handler ejecutable.
 * @param {{pipeline_id?:string}} input
 * @returns {Promise<{ok:boolean, pipeline_id?:string, cpr?:number, currency?:string,
 *   cpr_source?:string, as_of?:string, table?:object, error?:string}>}
 */
export async function handler(input = {}) {
  const cpr_source = 'fallback_static'; // Fase 1 — ver TODO Fase 2 arriba.
  const as_of = '2026-05-18';

  // Sin pipeline_id → tabla completa.
  if (!input.pipeline_id) {
    return {
      ok: true,
      cpr_source,
      currency: 'MXN',
      as_of,
      table: Object.fromEntries(
        Object.entries(CPR_FALLBACK).map(([id, v]) => [id, { cpr: v.cpr, name: v.name }]),
      ),
    };
  }

  const pid = String(input.pipeline_id);
  const row = CPR_FALLBACK[pid];
  if (!row) {
    return { ok: false, error: `pipeline_id desconocido: ${pid}`, cpr_source };
  }

  return {
    ok: true,
    pipeline_id: pid,
    cpr: row.cpr,
    currency: 'MXN',
    cpr_source,
    as_of,
  };
}

// Default export es la función handler con props .toolDefinition y .handler
// para permitir tanto `await getCprTable(input)` (función) como
// `getCprTable.handler(...)` y `getCprTable.toolDefinition`.
// Mismo patrón que read-kpis.js / read-pipeline.js (cierra P0-2 / R-19 BIS).
handler.toolDefinition = toolDefinition;
handler.handler = handler;
export default handler;
