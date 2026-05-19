/**
 * GioLens — Catálogo canónico de eventos Inngest
 *
 * 8 eventos definidos en el plan Sprint 4 GIOCORE v10.
 * Namespace fijo: `giolens/*` (separa de otros productos en la misma cuenta Inngest).
 *
 * Convenciones:
 *   - Snake_case en payload, kebab/dot en nombre.
 *   - Todo payload debe incluir `correlation_id` (uuid) para rastrear cascadas.
 *   - Timestamps en Unix ms.
 *   - `pipeline_id` siempre como string (Wapify los entrega así).
 */

export const EVENTS = {
  LEAD_MESSAGE_RECEIVED:          'giolens/lead.message_received',
  LEAD_SILENCE_DETECTED:          'giolens/lead.silence_detected',
  LEAD_REACTIVATION_SENT:         'giolens/lead.reactivation_sent',
  CAMPAIGN_FATIGUE_DETECTED:      'giolens/campaign.fatigue_detected',
  SEGMENTATION_REQUESTED:         'giolens/segmentation.requested',
  ARBITRAGE_REQUESTED:            'giolens/arbitrage.requested',
  CONVERSATION_DISTILL_REQUESTED: 'giolens/conversation.distill_requested',
  SYNC_WAPIFY_PULL:               'giolens/sync.wapify_pull',
};

/**
 * Evento extra (no canónico Sprint 4 pero usado por batch-auto-prompt.js).
 * Mantener fuera de EVENTS hasta promoverlo en doc.
 */
export const EVENTS_EXPERIMENTAL = {
  CAMPAIGN_BATCH_VARIANT_REQUESTED: 'giolens/campaign.batch_variant_requested',
};

// ─── JSDoc typedefs de payloads ───────────────────────────────────────────────

/**
 * @typedef {Object} LeadMessageReceivedData
 * @property {string} correlation_id  uuid para rastrear cascada
 * @property {string} contact_id      Wapify contact id
 * @property {string} pipeline_id     Wapify pipeline id
 * @property {string} stage_name      Etapa actual de la opportunity
 * @property {string} message_text    Texto recibido (post clean-message)
 * @property {number} received_at     Unix ms
 * @property {'lead'|'bot'} sender    Quién envió
 *
 * Emitido por: webhook.js cuando llega un mensaje entrante.
 * Consumido por: scan-reactivations (resetea timers), distill-conversation (acumula).
 */

/**
 * @typedef {Object} LeadSilenceDetectedData
 * @property {string} correlation_id
 * @property {string} contact_id
 * @property {string} pipeline_id
 * @property {string} stage_name
 * @property {number} silence_ms      ms desde last_interaction
 * @property {number} last_interaction Unix ms
 * @property {number} last_sent       Unix ms
 *
 * Emitido por: scan-reactivations.js (cron 5m).
 * Consumido por: send-reactivation.js.
 */

/**
 * @typedef {Object} LeadReactivationSentData
 * @property {string} correlation_id
 * @property {string} contact_id
 * @property {string} pipeline_id
 * @property {string} stage_name
 * @property {'baja'|'media'|'alta'} urgencia
 * @property {string} script_preview  primeros 80 chars
 * @property {number} sent_at         Unix ms
 * @property {boolean} dry_run
 *
 * Emitido por: send-reactivation.js.
 * Consumido por: analytics/dashboard (futuro).
 */

/**
 * @typedef {Object} CampaignFatigueDetectedData
 * @property {string} correlation_id
 * @property {string} campaign_id     Meta campaign id
 * @property {string} pipeline        Nombre humano del pipeline asociado
 * @property {number} ctr_drop_pct    % de caída vs semana previa
 * @property {number} cpc_rise_pct    % de subida vs semana previa
 * @property {'🟢'|'🟡'|'🔴'} semaforo
 *
 * Emitido por: run-arbitraje.js.
 * Consumido por: notificaciones (futuro), batch-auto-prompt (regenera creative copy).
 */

/**
 * @typedef {Object} SegmentationRequestedData
 * @property {string} correlation_id
 * @property {string[]} [pipeline_ids] Si vacío, segmenta los 5
 * @property {boolean} [force_refresh] Si true, ignora cache <24h
 *
 * Emitido por: cron diario 8am o request manual desde dashboard.
 * Consumido por: run-microseg.js.
 */

/**
 * @typedef {Object} ArbitrageRequestedData
 * @property {string} correlation_id
 * @property {string[]} [campaign_ids] Si vacío, todas las campañas activas
 *
 * Emitido por: cron cada 6h o request manual.
 * Consumido por: run-arbitraje.js.
 */

/**
 * @typedef {Object} ConversationDistillRequestedData
 * @property {string} correlation_id
 * @property {string[]} contact_ids   Lote de hasta 50
 * @property {string}   pipeline_id
 *
 * Emitido por: webhook.js cuando un lead cierra/desaparece (futuro).
 * Consumido por: distill-conversation.js.
 */

/**
 * @typedef {Object} SyncWapifyPullData
 * @property {string} correlation_id
 * @property {string[]} [pipeline_ids]
 * @property {number}   [since_ms]    Si presente, incremental
 *
 * Emitido por: cron cada 15 minutos.
 * Consumido por: sync-wapify-cache.js → Supabase.
 */

/**
 * @typedef {Object} CampaignBatchVariantRequestedData
 * @property {string}   correlation_id
 * @property {string}   pipeline_id
 * @property {string}   stage_name
 * @property {number}   n_variants    1..10
 * @property {string[]} angulos       'urgencia'|'valor'|'social_proof'|'pregunta'|...
 *
 * Emitido por: dashboard o tras campaign.fatigue_detected.
 * Consumido por: batch-auto-prompt.js.
 */

// ─── Validator helper (C.0.11 Frente C · mitigación R4) ──────────────────────

/** Set de todos los nombres de evento conocidos (canónicos + experimental). */
const KNOWN_EVENT_NAMES = new Set([
  ...Object.values(EVENTS),
  ...Object.values(EVENTS_EXPERIMENTAL),
]);

/**
 * Construye un evento Inngest validado.
 *
 * events.js documenta `correlation_id` como obligatorio en todo payload, pero
 * hasta C.0.11 ningún emisor lo validaba (riesgo R4 del plan Frente C v2 —
 * cascadas no rastreables). Este helper lo enforce: lanza si falta.
 *
 * @param {string} name  nombre del evento — debería ∈ EVENTS / EVENTS_EXPERIMENTAL
 * @param {object} payload  data del evento; DEBE incluir `correlation_id` (string)
 * @returns {{name:string, data:object}}  evento listo para inngest.send()
 * @throws Error si name no es string, payload no es objeto, o falta correlation_id
 */
export function makeEvent(name, payload) {
  if (!name || typeof name !== 'string') {
    throw new Error('[makeEvent] name requerido (string)');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[makeEvent] payload requerido (object)');
  }
  if (!payload.correlation_id || typeof payload.correlation_id !== 'string') {
    throw new Error(`[makeEvent] payload.correlation_id obligatorio (string) para evento "${name}"`);
  }
  if (!KNOWN_EVENT_NAMES.has(name)) {
    // No bloquea — el namespace giolens/agent.* del bridge es legítimo y no
    // está en el catálogo. Solo avisa para detectar typos en eventos canónicos.
    console.warn(`[makeEvent] evento "${name}" no está en EVENTS ni EVENTS_EXPERIMENTAL`);
  }
  return { name, data: { ...payload } };
}

export default EVENTS;
