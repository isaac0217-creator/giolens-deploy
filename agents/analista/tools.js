/**
 * GioLens — Agente Analista · tools.js
 * Rol: Declara el array de tools (formato Anthropic Tool Use) que el
 *      Analista puede invocar. Re-importa las implementaciones desde
 *      /agents/_shared/tools/.
 *
 * El Analista es READ-ONLY: solo se exponen herramientas de lectura.
 * Nunca añadir aquí una tool que mute estado (pause_ad, send_message, etc.).
 */

import readKpis from '../_shared/tools/read-kpis.js';
import readPipeline from '../_shared/tools/read-pipeline.js';

// Definiciones que se pasan a Anthropic como `tools` en la request.
export const TOOL_DEFINITIONS = [
  {
    name: 'read_kpis',
    description:
      'Lee snapshots de Meta Ads para un pipeline en un período dado. Devuelve gasto, impresiones, clicks, CTR, CPM, CPR y leads generados. Solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: {
          type: 'string',
          description: 'ID del pipeline GioLens. Uno de: 216977, 755062, 252999, 94103, 273944.',
        },
        period: {
          type: 'string',
          description: "Período a leer. Ej: 'last_24h', 'last_7d', 'last_30d'.",
        },
      },
      required: ['pipeline_id', 'period'],
    },
  },
  {
    name: 'read_pipeline',
    description:
      'Lee el estado actual de un pipeline en CRM Wapify: leads por etapa, leads estancados, tiempo promedio por etapa. Solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: {
          type: 'string',
          description: 'ID del pipeline GioLens. Uno de: 216977, 755062, 252999, 94103, 273944.',
        },
      },
      required: ['pipeline_id'],
    },
  },
];

// Mapa nombre → implementación. graph.js usa esto para resolver tool_use.
export const TOOL_HANDLERS = {
  read_kpis: readKpis,
  read_pipeline: readPipeline,
};

export default TOOL_DEFINITIONS;
