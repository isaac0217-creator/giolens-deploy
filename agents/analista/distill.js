/**
 * GioLens — Agente Analista · distill.js  (Frente C · C.2.5)
 *
 * Capability NUEVA: distilación batched de conversaciones lead↔bot.
 *
 * NO toca el flujo runAnalista ni su system prompt (prompt.js queda intacto —
 * regla inviolable "no tocar prompts agentes"). Este módulo tiene su propio
 * system prompt de distilación, separado del prompt de KPIs del Analista.
 *
 * Comprime conversaciones largas en resúmenes estructurados con 1 sola llamada
 * Haiku por lote (amortiza ~5x tokens vs 1 call por contacto).
 *
 * Invocado por: inngest/functions/distill-conversation.js (vía analista.distillBatch).
 */

import { callClaude } from '../_shared/anthropic.js';
import { calcUSD } from '../_shared/cost-tracker.js';

const MODEL = 'claude-haiku-4-5'; // distilación = compresión barata → Haiku

const DISTILL_SYSTEM_PROMPT = `Eres el módulo de distilación de conversaciones de GioLens Vision Care (óptica en Tijuana, MX).
Recibes un lote de conversaciones lead↔bot. Para CADA conversación produces un resumen estructurado.

Responde SOLO con JSON válido — sin markdown, sin bloques de código, sin texto adicional:
{
  "distilled": [
    {
      "contact_id": "<el id EXACTO recibido>",
      "summary": "<2-3 líneas: qué pidió el lead, qué respondió el bot, dónde quedó la conversación>",
      "sentiment": "positivo" | "neutral" | "negativo",
      "next_action": "<acción concreta sugerida para avanzar al lead>",
      "objections": ["<objeción detectada en los mensajes>", ...]
    }
  ]
}

Reglas:
- Un objeto por cada conversación recibida, con el contact_id EXACTO.
- summary, sentiment y next_action SIEMPRE con contenido real (nunca vacío).
- sentiment EXACTAMENTE uno de: positivo, neutral, negativo.
- objections puede ser []. NUNCA inventes datos que no estén en los mensajes.`;

const SENTIMENTS = new Set(['positivo', 'neutral', 'negativo']);

/**
 * Schema strict (PRE-5) de un item distilado: normaliza y repara campos para
 * garantizar el contrato {contact_id, summary, sentiment, next_action, objections}.
 */
export function normalizeDistilled(item, contactId) {
  const o = item && typeof item === 'object' ? item : {};
  return {
    contact_id:  String(o.contact_id || contactId || ''),
    summary:     typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : 'sin_resumen',
    sentiment:   SENTIMENTS.has(o.sentiment) ? o.sentiment : 'neutral',
    next_action: typeof o.next_action === 'string' && o.next_action.trim() ? o.next_action.trim() : 'sin_accion',
    objections:  Array.isArray(o.objections) ? o.objections.map(String) : [],
  };
}

/** Parsea el JSON del modelo. Tolerante a wrappers de texto. */
function parseDistilled(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const p = JSON.parse(rawText);
    if (Array.isArray(p.distilled)) return p.distilled;
  } catch (_) { /* sigue */ }
  const m = rawText.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (Array.isArray(p.distilled)) return p.distilled;
    } catch (_) { /* cae al default */ }
  }
  return null;
}

/**
 * Distila un lote de conversaciones en resúmenes estructurados.
 * @param {object} args
 * @param {Array<{contact_id:string, messages:Array}>} args.conversations
 * @param {string} [args.correlation_id]
 * @returns {Promise<{distilled:object[], cost_usd:number, latency_ms:number, model:string, error:string|null}>}
 */
export async function distillConversations({ conversations = [], correlation_id } = {}) {
  const t0 = Date.now();
  const list = Array.isArray(conversations) ? conversations : [];

  if (list.length === 0) {
    return { distilled: [], cost_usd: 0, latency_ms: Date.now() - t0, model: MODEL, error: null };
  }

  // Conversaciones sin mensajes → no se mandan al LLM (ahorra tokens).
  const withMessages = list.filter((c) => Array.isArray(c?.messages) && c.messages.length > 0);
  if (withMessages.length === 0) {
    return {
      distilled: list.map((c) =>
        normalizeDistilled({ summary: 'sin_mensajes', next_action: 'esperar_actividad' }, c?.contact_id)),
      cost_usd: 0,
      latency_ms: Date.now() - t0,
      model: MODEL,
      error: 'empty_conversations',
    };
  }

  const userMessage = [
    `Lote de ${withMessages.length} conversación(es) a distilar.`,
    correlation_id ? `correlation_id: ${correlation_id}` : '',
    '',
    'Conversaciones (JSON):',
    JSON.stringify(withMessages.map((c) => ({ contact_id: c.contact_id, messages: c.messages })), null, 1),
    '',
    'Emite el JSON {distilled:[...]} según el system prompt.',
  ].filter(Boolean).join('\n');

  const response = await callClaude({
    model: MODEL,
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  if (response?.error) {
    return {
      distilled: list.map((c) =>
        normalizeDistilled({ summary: 'distill_error', next_action: 'reintentar' }, c?.contact_id)),
      cost_usd: 0,
      latency_ms: Date.now() - t0,
      model: MODEL,
      error: response.error,
    };
  }

  const rawText =
    response?.text ??
    (Array.isArray(response?.content)
      ? response.content.find((b) => b.type === 'text')?.text
      : null) ??
    '';
  const parsed = parseDistilled(rawText);

  // Empareja por contact_id; PRE-5: normaliza cada item del contrato.
  const byId = new Map((parsed || []).map((it) => [String(it?.contact_id || ''), it]));
  const distilled = list.map((c) => normalizeDistilled(byId.get(String(c?.contact_id || '')), c?.contact_id));

  return {
    distilled,
    cost_usd: calcUSD(response?.usage || null, MODEL),
    latency_ms: Date.now() - t0,
    model: MODEL,
    error: parsed ? null : 'parse_failed',
  };
}

export default distillConversations;
