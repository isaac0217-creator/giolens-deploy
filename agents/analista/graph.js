/**
 * GioLens — Agente Analista · graph.js
 * Rol: Orquestación del flujo de análisis. Por ahora es JS plano —
 *      cuando LangGraph esté instalado, este archivo migra a un StateGraph.
 *
 * Flujo runAnalista({ pipelineIds, period }):
 *   1. Para cada pipeline → read_kpis + read_pipeline
 *   2. Agrega los datos en un contexto único
 *   3. Llama a Claude (Sonnet 4) con SYSTEM_PROMPT + contexto + tools
 *   4. Parsea el JSON de salida (insights[])
 *   5. Publica al bus cada insight con severity >= 'medium' como agent_message
 *   6. Registra el costo (trackCost)
 *   7. Retorna { insights, cost_usd, latency_ms }
 *
 * TODO Fase 2: migrar a LangGraph StateGraph cuando esté instalado.
 * TODO: persistir runs en Supabase (tabla agent_runs) cuando exista.
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { trackCost } from '../_shared/cost-tracker.js';
import readKpis from '../_shared/tools/read-kpis.js';
import readPipeline from '../_shared/tools/read-pipeline.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools.js';

const MODEL = 'claude-sonnet-4'; // Sonnet 4 default según HTML maestro §15
const SEVERITY_PUBLISH_THRESHOLD = ['medium', 'high', 'critical'];

/**
 * Recolecta KPIs + estado de pipeline para los IDs dados.
 * Aísla errores por pipeline para no abortar el run completo.
 */
async function collectPipelineContext(pipelineIds, period) {
  const context = {};
  const errors = [];

  for (const pid of pipelineIds) {
    context[pid] = { pipeline_id: pid, kpis: null, pipeline_state: null };

    try {
      context[pid].kpis = await readKpis({ pipeline_id: pid, period });
    } catch (err) {
      errors.push({ pipeline_id: pid, tool: 'read_kpis', error: err.message });
      context[pid].kpis = { error: err.message };
    }

    try {
      context[pid].pipeline_state = await readPipeline({ pipeline_id: pid });
    } catch (err) {
      errors.push({ pipeline_id: pid, tool: 'read_pipeline', error: err.message });
      context[pid].pipeline_state = { error: err.message };
    }
  }

  return { context, errors };
}

/**
 * Parsea el JSON de respuesta del modelo. Tolerante a wrappers de texto.
 */
function parseInsights(rawText) {
  if (!rawText || typeof rawText !== 'string') return { insights: [] };

  // Intento directo
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed.insights)) return parsed;
  } catch (_) {
    // sigue
  }

  // Extrae primer bloque {...} balanceado
  const match = rawText.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.insights)) return parsed;
    } catch (_) {
      // cae al default
    }
  }

  return { insights: [] };
}

/**
 * Publica insights de severity medium+ al bus como agent_message.
 */
async function publishHighSeverityInsights(insights) {
  const toPublish = (insights || []).filter((i) =>
    SEVERITY_PUBLISH_THRESHOLD.includes(i.severity),
  );

  for (const insight of toPublish) {
    await publish({
      type: 'agent_message',
      from: 'analista',
      severity: insight.severity,
      payload: insight,
      ts: new Date().toISOString(),
    });
  }

  return toPublish.length;
}

/**
 * Ejecuta el ciclo completo del Analista.
 * @param {{ pipelineIds: string[], period: string }} args
 * @returns {Promise<{ insights: object[], cost_usd: number, latency_ms: number, published: number, errors: object[] }>}
 */
export async function runAnalista({ pipelineIds, period = 'last_24h' } = {}) {
  const t0 = Date.now();

  if (!Array.isArray(pipelineIds) || pipelineIds.length === 0) {
    throw new Error('runAnalista: pipelineIds debe ser un array no vacío');
  }

  // Step 1 + 2: recolectar y agregar contexto
  const { context, errors } = await collectPipelineContext(pipelineIds, period);

  const userMessage = [
    `Período: ${period}`,
    `Pipelines analizados: ${pipelineIds.join(', ')}`,
    '',
    'Contexto recolectado (JSON):',
    JSON.stringify(context, null, 2),
    '',
    errors.length > 0
      ? `Errores de herramienta (informativo, no abortar): ${JSON.stringify(errors)}`
      : 'Sin errores de herramienta.',
    '',
    'Emite el JSON de insights según las reglas del system prompt.',
  ].join('\n');

  // Step 3: llamar a Claude
  const response = await callClaude({
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 4096,
  });

  // Step 4: extraer texto y parsear JSON
  const rawText =
    response?.text ??
    (Array.isArray(response?.content)
      ? response.content.find((b) => b.type === 'text')?.text
      : null) ??
    '';

  const { insights } = parseInsights(rawText);

  // Step 5: publicar insights medium+ al bus
  const published = await publishHighSeverityInsights(insights);

  // Step 6: trackear costo
  const cost_usd =
    typeof response?.cost_usd === 'number'
      ? response.cost_usd
      : (response?.usage?.input_tokens ?? 0) * 0.000003 +
        (response?.usage?.output_tokens ?? 0) * 0.000015;

  await trackCost({
    agent: 'analista',
    model: MODEL,
    cost_usd,
    usage: response?.usage ?? null,
    ts: new Date().toISOString(),
  });

  const latency_ms = Date.now() - t0;

  return { insights, cost_usd, latency_ms, published, errors };
}

export default runAnalista;
