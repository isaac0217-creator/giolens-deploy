/**
 * GioLens — Motor #2 Fragmento: Reactivation Check
 * URL: /api/reactivation-check
 *
 * Vercel Cron: cada 5 minutos (requiere Vercel Pro)
 * Invocar manualmente: GET /api/reactivation-check
 *                      POST /api/reactivation-check (desde cron)
 *
 * ── LÓGICA ──
 * Para cada pipeline, busca leads donde:
 *   1. updated_at está en los últimos 15 min (pre-filtro barato — evita llamadas innecesarias)
 *   2. La etapa NO es terminal (VISITA CONFIRMADA, FUERA DE CATÁLOGO, etc.)
 *   3. Al fetchear el contacto: last_sent > last_interaction (bot ya respondió, lead no ha contestado)
 *   4. (ahora - last_interaction) está entre 4 y 12 minutos (ventana de 5-min con margen para jitter de cron)
 *
 * ── DEDUPLICACIÓN ──
 * La ventana de 4-12 minutos actúa como deduplicación natural:
 * Un cron cada 5 min solo "ve" cada lead UNA VEZ en su ventana de 5 min.
 *
 * ── SEGURIDAD ──
 * DRY_RUN=true (env var) → log en consola, NO envía mensajes
 * MAX_SENDS_PER_RUN = 5 → cap de seguridad para evitar mass-messaging
 *
 * ── CAMPOS WAPIFY CONFIRMADOS ──
 * Contact: last_interaction (Unix ms, lead→bot), last_sent (Unix ms, bot→lead)
 * Opportunity: updated_at (ISO string CST), stage.name, contact_id
 */

const WAPIFY_TOKEN = process.env.WAPIFY_TOKEN;
const WAPIFY_BASE  = 'https://ap.whapify.ai/api';

// Etapas terminales — NO reactivar leads aquí
const TERMINAL_STAGES = new Set([
  'VISITA CONFIRMADA', 'visita confirmada',
  'FUERA DE CATÁLOGO', 'fuera del flujo', 'FUERA DEL FLUJO',
  'CATCH-ALL',
]);

const PIPELINES = ['216977', '755062', '252999', '94103', '273944'];

// Ventana de reactivación: entre 4 y 12 minutos sin respuesta del lead
const MIN_SILENCE_MS = 4  * 60 * 1000;
const MAX_SILENCE_MS = 12 * 60 * 1000;

// Pre-filtro: solo fetchear contacto si la opportunity fue actualizada en los últimos N minutos
const OPPORTUNITY_WINDOW_MS = 15 * 60 * 1000;

// Límite de seguridad: máximo envíos por ejecución del cron
const MAX_SENDS_PER_RUN = 5;

// DRY_RUN: true = solo log, no envía. Usar para verificar lógica antes de activar.
const DRY_RUN = process.env.REACTIVATION_DRY_RUN !== 'false';

// ─── Helpers ───

async function wapGet(path) {
  try {
    const r = await fetch(`${WAPIFY_BASE}/${path}`, {
      headers: { 'X-ACCESS-TOKEN': WAPIFY_TOKEN },
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function wapPost(path, body) {
  try {
    const r = await fetch(`${WAPIFY_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'X-ACCESS-TOKEN': WAPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: r.ok ? await r.json() : await r.text() };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

/** Parsea "2026-05-11 17:28:28" (Wapify devuelve fechas en CST = UTC-6) a Unix ms */
function parseWapifyDate(str) {
  if (!str) return 0;
  return new Date(str.replace(' ', 'T') + '-06:00').getTime();
}

/** Obtiene leads de un pipeline con updated_at en los últimos N ms */
async function getRecentLeads(pipelineId, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recent = [];
  let offset = 0;

  for (let page = 0; page < 20; page++) {
    const r = await wapGet(`pipelines/${pipelineId}/opportunities?limit=100&offset=${offset}`);
    const batch = r?.data || [];
    if (batch.length === 0) break;

    for (const opp of batch) {
      const updatedMs = parseWapifyDate(opp.updated_at);
      if (updatedMs >= cutoff && !TERMINAL_STAGES.has(opp.stage?.name)) {
        recent.push(opp);
      }
    }

    const lastUpdated = parseWapifyDate(batch[batch.length - 1]?.updated_at);
    if (lastUpdated < cutoff) break;

    if (batch.length < 100) break;
    offset += 100;
  }

  return recent;
}

/** Verifica si el lead necesita reactivación */
async function needsReactivation(contactId) {
  const contact = await wapGet(`contacts/${contactId}`);
  if (!contact) return { needs: false, reason: 'contact_fetch_failed' };

  const lastInteraction = Number(contact.last_interaction || 0);
  const lastSent        = Number(contact.last_sent        || 0);

  if (!lastInteraction) return { needs: false, reason: 'no_last_interaction' };

  const silenceMs = Date.now() - lastInteraction;
  const botAlreadyReplied = lastSent > lastInteraction;
  const inWindow = silenceMs >= MIN_SILENCE_MS && silenceMs <= MAX_SILENCE_MS;

  if (botAlreadyReplied && inWindow) {
    return {
      needs: true,
      silenceMin: Math.round(silenceMs / 60000 * 10) / 10,
      lastInteraction,
      lastSent,
      contact,
    };
  }

  return {
    needs: false,
    reason: !botAlreadyReplied ? 'lead_message_is_newest'
      : silenceMs < MIN_SILENCE_MS ? 'too_soon' : 'window_expired',
    silenceMin: Math.round(silenceMs / 60000 * 10) / 10,
  };
}

/** Pide script al Copiloto */
async function getCopilotoScript(pipelineId, stageName, contactId) {
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const r = await fetch(`${baseUrl}/api/copiloto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_id: pipelineId, stage_name: stageName, contact_id: contactId }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

/** Envía mensaje vía Wapify */
async function sendMessage(contactId, text) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Would send to ${contactId}: "${text.slice(0, 80)}"`);
    return { dry_run: true };
  }
  return wapPost(`contacts/${contactId}/send`, { message: text, type: 'text' });
}

// ─── Handler Principal ───

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const startTime = Date.now();
  console.log(`[REACTIVATION] Inicio. dry_run=${DRY_RUN}`);

  const report = {
    started_at:  new Date().toISOString(),
    dry_run:     DRY_RUN,
    pipelines:   {},
    candidates:  [],
    sent:        [],
    skipped:     [],
    errors:      [],
    total_sent:  0,
  };

  let totalSent = 0;

  for (const pid of PIPELINES) {
    if (totalSent >= MAX_SENDS_PER_RUN) {
      console.log(`[REACTIVATION] Cap de ${MAX_SENDS_PER_RUN} envíos alcanzado — deteniendo`);
      break;
    }

    try {
      const recentLeads = await getRecentLeads(pid, OPPORTUNITY_WINDOW_MS);
      report.pipelines[pid] = { recent_leads: recentLeads.length };
      console.log(`[REACTIVATION] Pipeline ${pid}: ${recentLeads.length} leads recientes`);

      for (const opp of recentLeads) {
        if (totalSent >= MAX_SENDS_PER_RUN) break;

        const contactId = opp.contact_id;
        const stageName = opp.stage?.name || 'NUEVO';

        try {
          const check = await needsReactivation(contactId);

          if (!check.needs) {
            report.skipped.push({ contact_id: contactId, stage: stageName, pipeline: pid, reason: check.reason, silence_min: check.silenceMin });
            continue;
          }

          const copiloto = await getCopilotoScript(pid, stageName, contactId);
          const scriptText = copiloto?.script || copiloto?.alternativa || null;

          if (!scriptText) {
            report.errors.push({ contact_id: contactId, error: 'copiloto_no_script' });
            continue;
          }

          const contactName = check.contact?.first_name || '';
          const finalScript = contactName
            ? scriptText.replace(/\[nombre\]/gi, contactName)
            : scriptText;

          report.candidates.push({ contact_id: contactId, stage: stageName, pipeline: pid, silence_min: check.silenceMin, script_preview: finalScript.slice(0, 80) });

          const sendResult = await sendMessage(contactId, finalScript);

          report.sent.push({ contact_id: contactId, stage: stageName, pipeline: pid, silence_min: check.silenceMin, urgencia: copiloto?.urgencia || 'media', send_result: sendResult });

          totalSent++;
          console.log(`[REACTIVATION] Enviado a ${contactId} (${stageName}, ${check.silenceMin}min silencio)`);

          await new Promise(r => setTimeout(r, 500));

        } catch (err) {
          report.errors.push({ contact_id: contactId, error: err.message });
        }
      }

    } catch (err) {
      console.error(`[REACTIVATION] Error en pipeline ${pid}:`, err.message);
      report.errors.push({ pipeline: pid, error: err.message });
    }
  }

  report.total_sent  = totalSent;
  report.duration_ms = Date.now() - startTime;
  report.finished_at = new Date().toISOString();

  console.log(`[REACTIVATION] Fin. Enviados: ${totalSent}. Candidatos: ${report.candidates.length}. Tiempo: ${report.duration_ms}ms`);

  return res.status(200).json(report);
}
