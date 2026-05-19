/**
 * GioLens — Worker: send-reactivation
 *
 * Reemplaza el bloque "para cada candidato → copiloto → send" de /api/reactivation-check.
 * En Inngest cada lead es un evento independiente: aislamiento por contact_id,
 * retries automáticos en error transient, concurrency limit por contacto para no spamear.
 *
 * Trigger: event `giolens/lead.silence_detected`
 * Concurrency: { key: 'event.data.contact_id', limit: 1 }  — nunca dos sends al mismo contacto en paralelo
 * Retries: 2 (con backoff exponencial nativo de Inngest)
 *
 * Steps:
 *   1. copiloto-script   → POST /api/copiloto interno (o función directa cuando se migre)
 *   2. jitter-sleep      → step.sleep(0..10s) para evitar patrón bot
 *   3. wapify-send       → POST contacts/{id}/send (respeta DRY_RUN env)
 *   4. emit-reactivation-sent → giolens/lead.reactivation_sent
 */

import { inngest } from '../client.js';
import { EVENTS } from '../events.js';

const DRY_RUN = process.env.REACTIVATION_DRY_RUN !== 'false';

export default inngest.createFunction(
  {
    id: 'giolens-send-reactivation',
    concurrency: { key: 'event.data.contact_id', limit: 1 },
    retries: 2,
  },
  { event: EVENTS.LEAD_SILENCE_DETECTED },
  async ({ event, step }) => {
    const { contact_id, pipeline_id, stage_name, correlation_id } = event.data || {};
    console.log('[send-reactivation] start', contact_id, stage_name);

    // Step 1: pedir script al copiloto
    const copiloto = await step.run('copiloto-script', async () => {
      // TODO Fase 2: invocar lógica de /api/copiloto.js (o función directa cuando se refactorice).
      // Stub: estructura idéntica al response real.
      console.log(`[send-reactivation] stub copiloto for ${contact_id}`);
      return {
        script: 'Hola [nombre], ¿pudiste revisar la opción que te compartí?',
        alternativa: '¿Sigues interesado o prefieres que te contacte después?',
        urgencia: 'media',
      };
    });

    const scriptText = copiloto?.script || copiloto?.alternativa;
    if (!scriptText) {
      console.warn('[send-reactivation] no script, abort', contact_id);
      return { skipped: true, reason: 'no_script' };
    }

    // Step 2: jitter aleatorio 0-10s para no parecer bot
    const jitterMs = Math.floor(Math.random() * 10_000);
    await step.sleep?.('jitter', `${jitterMs}ms`);

    // Step 3: envío vía Wapify
    const sendResult = await step.run('wapify-send', async () => {
      if (DRY_RUN) {
        console.log(`[send-reactivation][DRY] ${contact_id} ← "${scriptText.slice(0, 60)}"`);
        return { dry_run: true, status: 200 };
      }
      // TODO Fase 2: implementar fetch real a WAPIFY_BASE/contacts/{id}/send
      console.log(`[send-reactivation] stub wapify send ${contact_id}`);
      return { stub: true, status: 200 };
    });

    // Step 4: emite reactivation_sent — usar step.sendEvent (idempotencia bajo retry).
    // Antes usaba `inngest.send` directo → si el run reintentaba tras fallo,
    // emitía evento duplicado → spam al lead. Cierra P0 audit Agent E.
    await step.sendEvent('emit-reactivation-sent', {
      name: EVENTS.LEAD_REACTIVATION_SENT,
      data: {
        correlation_id,
        contact_id,
        pipeline_id,
        stage_name,
        urgencia: copiloto.urgencia || 'media',
        script_preview: scriptText.slice(0, 80),
        sent_at: Date.now(),
        dry_run: DRY_RUN,
      },
    });

    return { sent: true, contact_id, dry_run: DRY_RUN, send_result: sendResult };
  }
);
