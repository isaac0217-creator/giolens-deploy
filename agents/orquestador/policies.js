/**
 * GioLens — Agente Orquestador · policies.js
 * Rol: Tabla de prioridades, ranking de riesgo por agente y reglas de
 *      resolución de conflictos. Constantes + función pura computeWinner()
 *      para resolver conflictos deterministicamente cuando no hace falta
 *      escalar al humano.
 *
 * Estas constantes son la única fuente de verdad para:
 *   - prompt.js (las imprime en el SYSTEM_PROMPT)
 *   - graph.js  (las aplica como guardia post-LLM)
 *   - __tests__/policies.test.js
 *
 * NO modificar sin actualizar el prompt y los tests.
 */

// ────────────────────────────────────────────────────────────────────────────
// PRIORIDADES (P1 = máxima urgencia → P5 = exploración)
// ────────────────────────────────────────────────────────────────────────────
export const PRIORITIES = Object.freeze({
  P1: {
    level: 1,
    label: 'blocker_prod',
    description: 'Blocker producción (rollback, kill switch). Ejecutar inmediato.',
    sla_minutes: 0,
  },
  P2: {
    level: 2,
    label: 'human_pending',
    description: 'Decisiones humanas pendientes >30min sin atender. Notificar y escalar.',
    sla_minutes: 30,
  },
  P3: {
    level: 3,
    label: 'approved_execution',
    description: 'Ejecución de propuestas ya aprobadas.',
    sla_minutes: 60,
  },
  P4: {
    level: 4,
    label: 'scheduled_analysis',
    description: 'Análisis programados (cron Analista).',
    sla_minutes: 360,
  },
  P5: {
    level: 5,
    label: 'exploration',
    description: 'Exploración/eval. Sin urgencia.',
    sla_minutes: 1440,
  },
});

/**
 * Devuelve el bucket de prioridad como número {1..5} a partir de un input
 * numérico, string ('P1'..'P5') o etiqueta. Default 5 (exploración).
 */
export function normalizePriority(p) {
  if (typeof p === 'number' && p >= 1 && p <= 5) return Math.floor(p);
  if (typeof p === 'string') {
    const m = p.toUpperCase().match(/^P([1-5])$/);
    if (m) return Number(m[1]);
    for (const [key, val] of Object.entries(PRIORITIES)) {
      if (val.label === p.toLowerCase()) return val.level;
      if (key === p.toUpperCase()) return val.level;
    }
  }
  return 5;
}

// ────────────────────────────────────────────────────────────────────────────
// RANKING DE RIESGO POR AGENTE (menor = menos riesgo → gana en empates)
// ────────────────────────────────────────────────────────────────────────────
//   Analista       1 — sólo lee, nunca muta
//   QA             2 — lee + propone diagnósticos
//   Creativo       3 — genera assets (drafts en bucket)
//   Optimización   4 — toca budgets de Meta Ads (impacto $)
//   Desarrollador  5 — toca código del core (impacto sistémico)
//   Orquestador    -  no debe aparecer como proponente (sólo orquesta)
// ────────────────────────────────────────────────────────────────────────────
export const RISK_RANKING = Object.freeze({
  analista:      1,
  qa:            2,
  creativo:      3,
  optimizacion:  4,
  desarrollador: 5,
  orquestador:  99, // no debería proponer; si lo hace, pierde siempre
});

export function riskOf(agent) {
  const r = RISK_RANKING[String(agent || '').toLowerCase()];
  return typeof r === 'number' ? r : 99;
}

// ────────────────────────────────────────────────────────────────────────────
// REGLAS DE RESOLUCIÓN DE CONFLICTOS
// ────────────────────────────────────────────────────────────────────────────
export const CONFLICT_RULES = Object.freeze({
  // Si el impacto económico supera este umbral, NUNCA se resuelve solo:
  // siempre se escala al humano.
  ESCALATE_HUMAN_USD: 50,

  // Acciones irreversibles → siempre escalar humano.
  IRREVERSIBLE_ACTIONS: Object.freeze([
    'delete',
    'deactivate',
    'archive',
    'force_close',
    'drop_table',
    'permanent_pause',
  ]),

  // Acciones consideradas "merge-compatible": dos agentes pueden ejecutar
  // a la vez sin pisarse (típicamente generan variantes en buckets distintos).
  MERGE_COMPATIBLE_ACTIONS: Object.freeze([
    'generate_creative_variant',
    'export_asset',
    'snapshot_kpis',
    'enqueue_analysis',
  ]),
});

/**
 * ¿La acción es irreversible y por tanto debe escalar humano?
 */
export function isIrreversibleAction(action) {
  if (!action || typeof action !== 'string') return false;
  const a = action.toLowerCase();
  return CONFLICT_RULES.IRREVERSIBLE_ACTIONS.some((needle) => a.includes(needle));
}

/**
 * ¿Dos acciones son merge-compatibles? (mismo recurso, distintos buckets).
 */
export function areMergeCompatible(actionA, actionB) {
  if (!actionA || !actionB) return false;
  const a = String(actionA).toLowerCase();
  const b = String(actionB).toLowerCase();
  const isCompat = (x) =>
    CONFLICT_RULES.MERGE_COMPATIBLE_ACTIONS.some((needle) => x.includes(needle));
  return isCompat(a) && isCompat(b);
}

/**
 * ¿El impacto económico (USD) supera el umbral de escalación humana?
 */
export function exceedsHumanEscalationThreshold(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n) > CONFLICT_RULES.ESCALATE_HUMAN_USD;
}

// ────────────────────────────────────────────────────────────────────────────
// computeWinner — función pura, testeable, sin LLM
// ────────────────────────────────────────────────────────────────────────────
/**
 * Resuelve un conflicto entre N propuestas sobre el mismo recurso aplicando
 * las reglas duras. NO llama al modelo. graph.js usa esto como guardia
 * pre-LLM (atajo) y los tests lo verifican aislado.
 *
 * @param {Array<{
 *   agent: string,
 *   proposal_id: string,
 *   action: string,
 *   priority?: number|string,
 *   evidence?: object,
 *   estimated_delta_usd?: number,
 * }>} proposals
 * @returns {{
 *   decision: 'approve_one' | 'merge' | 'escalate_human' | 'reject_all',
 *   winner_proposal_id: string | null,
 *   blocked_proposals: string[],
 *   rationale: string,
 * }}
 */
export function computeWinner(proposals) {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return {
      decision: 'reject_all',
      winner_proposal_id: null,
      blocked_proposals: [],
      rationale: 'no proposals provided',
    };
  }
  if (proposals.length === 1) {
    return {
      decision: 'approve_one',
      winner_proposal_id: proposals[0].proposal_id || null,
      blocked_proposals: [],
      rationale: 'single proposal, auto-approve',
    };
  }

  // 1) Cualquier propuesta irreversible → escalar humano.
  for (const p of proposals) {
    if (isIrreversibleAction(p.action)) {
      return {
        decision: 'escalate_human',
        winner_proposal_id: null,
        blocked_proposals: proposals.map((x) => x.proposal_id),
        rationale: `acción irreversible detectada en proposal ${p.proposal_id} (${p.action}) — escalar humano`,
      };
    }
  }

  // 2) Cualquier impacto > umbral USD → escalar humano.
  for (const p of proposals) {
    if (exceedsHumanEscalationThreshold(p.estimated_delta_usd)) {
      return {
        decision: 'escalate_human',
        winner_proposal_id: null,
        blocked_proposals: proposals.map((x) => x.proposal_id),
        rationale: `impacto |${p.estimated_delta_usd} USD| > $${CONFLICT_RULES.ESCALATE_HUMAN_USD} en proposal ${p.proposal_id} — escalar humano`,
      };
    }
  }

  // 3) Si TODAS son merge-compatibles entre sí → merge (aprobar ambas).
  let allCompat = true;
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      if (!areMergeCompatible(proposals[i].action, proposals[j].action)) {
        allCompat = false;
        break;
      }
    }
    if (!allCompat) break;
  }
  if (allCompat) {
    return {
      decision: 'merge',
      winner_proposal_id: null,
      blocked_proposals: [],
      rationale: 'todas las acciones son merge-compatibles (buckets distintos)',
    };
  }

  // 4) Ordenar por prioridad (menor número = más urgente) → luego por riesgo
  //    (menor riesgo = más conservador, gana en empates).
  const ranked = [...proposals].sort((a, b) => {
    const pa = normalizePriority(a.priority);
    const pb = normalizePriority(b.priority);
    if (pa !== pb) return pa - pb;
    return riskOf(a.agent) - riskOf(b.agent);
  });

  const winner = ranked[0];
  const losers = ranked.slice(1).map((p) => p.proposal_id);

  return {
    decision: 'approve_one',
    winner_proposal_id: winner.proposal_id,
    blocked_proposals: losers,
    rationale: `priority ${normalizePriority(winner.priority)} + risk ${riskOf(winner.agent)} → gana ${winner.agent}/${winner.proposal_id}`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Heurísticas para share_context con target_agents='auto'
// ────────────────────────────────────────────────────────────────────────────
/**
 * Resuelve a qué agentes debe ir un insight cuando target='auto'.
 * Heurística documentada en prompt.js (sección "share_context con auto").
 *
 * @param {{type:string, payload?:object}} insight
 * @returns {string[]} lista de agent names (sin duplicados, sin 'orquestador')
 */
export function inferTargetsForInsight(insight) {
  if (!insight || typeof insight !== 'object' || !insight.type) return [];
  const t = String(insight.type).toLowerCase();
  const set = new Set();

  // Insights de fatiga creativa → creativo + optimización
  if (t.includes('fatiga') || t.includes('fatigue') || t.includes('creative_fatigue')) {
    set.add('creativo');
    set.add('optimizacion');
  }
  // Insights de CPR / budget / spend → optimización
  if (t.includes('cpr') || t.includes('budget') || t.includes('spend') || t.includes('cpa')) {
    set.add('optimizacion');
  }
  // Bugs / fallas técnicas → desarrollador
  if (t.includes('bug') || t.includes('error') || t.includes('failure') || t.includes('regression')) {
    set.add('desarrollador');
  }
  // QA flags → desarrollador + qa
  if (t.includes('qa_') || t.includes('test_')) {
    set.add('desarrollador');
    set.add('qa');
  }
  // Cualquier evento crítico → analista (siempre debe estar enterado)
  if (
    t.includes('critical') ||
    t.includes('alert') ||
    (insight.payload && insight.payload.severity === 'critical')
  ) {
    set.add('analista');
  }
  // Si nada matcheó, broadcast informativo al Analista
  if (set.size === 0) {
    set.add('analista');
  }
  // Nunca a sí mismo.
  set.delete('orquestador');
  return Array.from(set);
}

export default {
  PRIORITIES,
  RISK_RANKING,
  CONFLICT_RULES,
  normalizePriority,
  riskOf,
  isIrreversibleAction,
  areMergeCompatible,
  exceedsHumanEscalationThreshold,
  computeWinner,
  inferTargetsForInsight,
};
