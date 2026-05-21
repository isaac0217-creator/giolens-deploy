# Frente C v2 — Handoff

**Fecha:** 2026-05-21 · **Estado:** núcleo cerrado (C.1–C.5).

Frente C v2 (wiring LangGraph ↔ Inngest ↔ agentes) está cerrado a nivel
**núcleo**. Este documento lista lo que quedó fuera de alcance, diferido o en
stub — con TODOs accionables.

## Resumen de cierre

| Sub-fase | Estado | Evidencia |
|---|---|---|
| C.1 — trace + correlation_id | ✅ cerrado | `agents/_shared/run-with-trace.js` |
| C.2 — wiring Inngest ↔ agentes (7 sub-fases) | ✅ cerrado | smoke E2E `scripts/smoke-inngest-e2e.mjs` · commit `9c0faf0` |
| C.3 — gate de aprobación (backend) | ✅ cerrado | `agents/_shared/approval.js` + `approval-store.js` + tests |
| C.4 — smoke shadow Analista | ✅ cerrado | `scripts/smoke-shadow-analista.mjs` (`npm run smoke:shadow`) |
| C.5 — cierre + handoff | ✅ este doc + ADR-01 | — |

## TODOs diferidos

### 1. C.3 — UI/SSE del panel de aprobaciones → track dashboard

El núcleo entrega el **backend** del gate: `approval.js` registra decisiones en
`approval-store`, y en modo GATE publica un `request` al bus
(`to_agent:'panel-aprobaciones'`) y bloquea hasta recibir un `response`
(`to_agent:'approval-gate'`).

Lo que **NO** está en el núcleo (es dashboard web — ver ADR-01):
- Endpoint HTTP `GET /api/approvals/stream` (SSE) que reexpone el bus al navegador.
- Cablear `public/agents-approvals.html` a datos reales (hoy es demo estática).
- Render del histórico live en la UI.

**Contrato estable para el track dashboard:** el bus ya define el shape del
mensaje. El panel debe (a) suscribirse a `panel-aprobaciones` para recibir
`request`, y (b) publicar el veredicto como `{from_agent:'panel',
to_agent:'approval-gate', type:'response', context_refs:[decision_id],
payload:{approved, by, note}}`.

### 2. Activación del gate real en producción

`approval.js` corre en modo AUTO por defecto (`APPROVAL_AUTO_MODE` ausente o
≠`false`) — auto-aprueba todo, igual que el stub anterior. Esto mantiene verde
a `sim-agents` y a los runs reales mientras no haya panel humano conectado.

Para activar el gate real: setear `APPROVAL_AUTO_MODE=false` (+ opcionalmente
`APPROVAL_GATE_THRESHOLD_USD`, `APPROVAL_TIMEOUT_MS`) — **solo cuando el panel
del dashboard esté conectado**, si no los runs se cuelgan esperando veredicto.

### 3. Functions Inngest aún en stub (decisión §3.2 C)

`refresh-meta-token`, `sync-wapify-cache`, `batch-auto-prompt` siguen en stub —
no se wirearon a agentes reales en C.2 (decisión de posponer). Reactivar en
Frente D si aplica.

### 4. Idempotencia cross-run de los dual-trigger

`run-microseg` y `run-arbitraje` son dual-trigger (cron + event). La config
`idempotency` de Inngest solo se aplicó a las functions pure-event
(`send-reactivation`, `distill-conversation`). Confirmar el comportamiento de
clave vacía en cron contra Inngest Cloud antes de aplicarla a los dual-trigger.

### 5. Migración del approval-store a Supabase (Frente D)

`approval-store.js` es in-memory. En Frente D migra a la tabla `agent_decisions`
de Supabase: `register`→insert, `resolve`→update, `getPending`/`getHistory`→
select. La API pública del módulo ya está diseñada para ese reemplazo.

## Decisiones registradas

- **ADR-01** — frontera núcleo/dashboard del gate de aprobaciones
  (`_ENGINEERING/ADRs/` del vault GIOCORE).
