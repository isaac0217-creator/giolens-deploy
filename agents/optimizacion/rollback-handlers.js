/**
 * GioLens — Agente Optimizacion · rollback-handlers.js
 * Rol: Handlers concretos de rollback para las acciones que este agente puede
 *      disparar. Se registran al import (side-effect) en el registry compartido.
 *
 * El registry de _shared/rollback.js ya pre-registra placeholders por defecto
 * (ad_published, lead_stage_moved, budget_changed). Aqui los REEMPLAZAMOS por
 * versiones especificas del agente Optimizacion + agregamos kinds nuevos
 * (adset_paused) que el registry default no trae.
 *
 * Estado Fase 1: handlers STUB con log. Fase 2 cablear a Meta Graph API.
 */

import { register as registerRollback } from '../_shared/rollback.js';

/**
 * Restaura el daily_budget previo de un adset Meta.
 * @param {{adset_id:string, previous_budget:number}} payload
 */
async function rollbackBudgetChanged(payload = {}) {
  const { adset_id, previous_budget } = payload;
  if (!adset_id || typeof previous_budget !== 'number') {
    return { ok: false, error: 'adset_id y previous_budget requeridos' };
  }

  // TODO Fase 2: PATCH https://graph.facebook.com/v20.0/{adset_id}
  //              body: { daily_budget: Math.round(previous_budget * 100) /* cents */ }
  console.log(
    `[optimizacion][rollback:budget_changed][STUB] restore adset=${adset_id} -> ${previous_budget} USD/day`,
  );
  return {
    ok: true,
    detail: `stub: budget de adset=${adset_id} restaurado a $${previous_budget}/day`,
  };
}

/**
 * Reactiva un adset Meta previamente pausado.
 * @param {{adset_id:string}} payload
 */
async function rollbackAdsetPaused(payload = {}) {
  const { adset_id } = payload;
  if (!adset_id) return { ok: false, error: 'adset_id requerido' };

  // TODO Fase 2: POST https://graph.facebook.com/v20.0/{adset_id}
  //              body: { status: 'ACTIVE' }
  console.log(`[optimizacion][rollback:adset_paused][STUB] reactivate adset=${adset_id}`);
  return { ok: true, detail: `stub: adset=${adset_id} reactivado` };
}

// ────────────────────────────────────────────────────────────────────────────
// Registro al import (side-effect). Reemplaza placeholders del shared registry.
// ────────────────────────────────────────────────────────────────────────────
registerRollback('budget_changed', rollbackBudgetChanged);
registerRollback('adset_paused',   rollbackAdsetPaused);

export { rollbackBudgetChanged, rollbackAdsetPaused };

export default { rollbackBudgetChanged, rollbackAdsetPaused };
