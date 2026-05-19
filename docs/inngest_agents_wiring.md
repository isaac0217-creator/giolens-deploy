# Wiring `inngest/functions/*` ↔ `agents/{6}/`

**Autor:** Arquitecto senior (sesión 18 may 2026, noche)
**Estado:** Propuesta — espera input Isaac en §5 antes de Frente C.
**Contexto:** los 8 functions Inngest son stubs (`// TODO Fase 2`) confirmado por Agent E. Los 6 agentes son entrypoints exportables sin Inngest wrapper aún (`TODO Fase 2: envolver en inngest.createFunction`). Este doc define quién invoca a quién para destrabar Frente C.

---

## 1. Inventario de entrypoints `agents/{6}/index.js`

| Agente | Export default | Otros exports callables | Signature principal | Misión (1 línea) |
|---|---|---|---|---|
| **analista** | `executeAnalistaDailyRun` | `GIOLENS_PIPELINE_IDS`, `pingSupabase` | `({ period = 'last_24h' }) → { insights, published, cost_usd, latency_ms, errors }` | Detectar degradaciones de KPI y emitir insights JSON. NO ejecuta. |
| **qa** | `executeQADailyRun` | `runQAOnDemand({ targets, mode })`, `pingSupabase` | `() → { findings, summary, cost_usd, latency_ms }` · on-demand: `({ targets?, mode='evals' })` | Sandbox-only. Validar contratos de motores+agentes contra goldens. Bloquea promoción si `summary.blockers > 0`. |
| **creativo** | `executeCreativoOnDemand` | `generateScriptVariants`, `generateAdAngles`, `generateReactivationTemplate`, `pingSupabase` | `({ task: 'script'\|'ad'\|'reactivation', params }) → { variants/angles/templates, status: 'draft', approval, cost_usd }` | Genera DRAFT (nunca publica). `requires_approval: true`. |
| **optimizacion** | `executeOptimizacionDailyRun` | `applyApprovedProposal(id, proposal, approval)`, `pingSupabase` | `({ period }) → { proposals, validated, blocked, cost_usd }` | Propone cambios de budget/segment/copy/angle. `requires_approval=true` si delta > $50 USD. |
| **desarrollador** | `executeDesarrolladorOnDemand` | `analyzeQAFailure`, `generateFix`, `createPullRequestStub`, `pingSupabase` | `({ task: 'analyze_qa_failure'\|'generate_fix'\|'create_pull_request', params }) → { diagnosis/draft/pr, cost_usd }` | Diagnostica fallas QA, propone patches mínimos, PR stub (NUNCA push a main, NUNCA escribe disco). |
| **orquestador** | `executeOrquestadorOnDemand` | `scheduleAgentRun`, `resolveConflict`, `shareContext`, `pingSupabase` | `({ task: 'schedule_run'\|'resolve_conflict'\|'share_context', params }) → { schedule/resolution/share }` | Coordina prioridades, resuelve conflictos sobre el mismo recurso, reparte contexto entre agentes. NO invoca agentes directo, solo emite eventos. |

**Nota crítica:** todos los entrypoints son `async` planos hoy; ninguno está envuelto en `inngest.createFunction`. La idea de Frente C es que `inngest/functions/*.js` los invoquen como módulos planos (ESM `import`) dentro del `step.run` correspondiente — NO duplicar la lógica de cron/trigger en los handlers de agents.

---

## 2. Mapeo `function → agent` (decisión recomendada)

Convenciones:
- **inline** = el function llama al motor legacy `/api/*` (o reimplementa su lógica) sin involucrar agentes.
- **agent X** = el function debe invocar al export del agente correspondiente dentro de un `step.run`.
- **fan-out** = el function emite eventos para otro function downstream.

| Function | Trigger actual | Recomendación | Agente invocado | Por qué | Input al agent | Output al bus / downstream |
|---|---|---|---|---|---|---|
| `scan-reactivations` | cron `*/5 * * * *` | **inline** + fan-out | — (utility puro) | Es scan determinista de Wapify; el "criterio de candidato" (silence > N min, no terminal) es regla fija, no necesita LLM. Mantenerlo barato y rápido. Decisión LLM se traslada a `send-reactivation` (copiloto inline) o más tarde a un agente. | n/a | emite `LEAD_SILENCE_DETECTED` por candidato → `send-reactivation` |
| `send-reactivation` | event `LEAD_SILENCE_DETECTED` | **híbrido** (Fase 2 inline copiloto, Fase 3 → **creativo**) | Fase 2: ninguno (POST inline a `/api/copiloto`). Fase 3: `creativo` task=`reactivation` | Hoy el copiloto legacy ya hace el trabajo bien con Haiku (cheap). En Fase 3, el `Creativo` toma sobre él: maneja drafts, `requires_approval`, ángulos por pipeline. Migración debe ser feature-flag, no big-bang. | `{ pipelineId, stageIn: stage_name, daysInactive: silence_ms/86400000 }` | emite `LEAD_REACTIVATION_SENT` |
| `run-microseg` | event `SEGMENTATION_REQUESTED` / cron 8am CST | **híbrido** — inline clasificación + **analista** análisis | `analista` (Fase 3, post-MVP) | La clasificación de los 4 segmentos es determinista (recencia × posición × actividad); el LLM solo genera perfil + script + frecuencia. En Fase 3 el `Analista` puede absorber ese segundo paso y emitir `insights` con severity baja por segmento. Hoy: replicar `/api/microseg` inline. | `{ period: 'last_24h', pipelineIds: targets.map(p=>p.id), context: { segmentations: classifications } }` (vía nuevo arg, no en signature actual) | persist `segmentations` table; analista emite insights al bus interno |
| `run-arbitraje` | event `ARBITRAGE_REQUESTED` / cron `0 */6 * * *` | **híbrido** — inline fetch+score + **optimizacion** propuestas | `optimizacion` (executeOptimizacionDailyRun, ampliado) | El fetch Meta + scoring (CTR drop, CPC rise, semáforo) es determinista; lo que tiene que generar el LLM es la **propuesta de redistribución de presupuesto**, que es exactamente la misión del `Optimizacion`. Hoy lo hace Haiku inline en `/api/arbitraje.js`. Migrar a Optimizacion: `requires_approval=true` si `estimated_delta_usd > 50`. | `{ period: 'last_7d_vs_prev', pipelineIds: GIOLENS_PIPELINE_IDS, scored_campaigns: scored }` (necesita nueva variante: `analyzeAndPropose({ context })`) | emite `CAMPAIGN_FATIGUE_DETECTED` por campaña 🔴; persist `arbitraje_runs`; proposals quedan en cola humano-approval |
| `distill-conversation` | event `CONVERSATION_DISTILL_REQUESTED` | **inline** (utility puro) | — | Es compresión LLM 1-shot batched (Haiku con schema JSON estricto). No requiere identidad de agente, no requiere approval gate, no se cruza con ningún rol de los 6. Mantener inline ahorra latencia y costo. | n/a | persist `conversation_summaries` |
| `sync-wapify-cache` | event `SYNC_WAPIFY_PULL` / cron `*/15 * * * *` | **inline** (utility puro) | — | Es ETL puro Wapify → Supabase. Cero LLM. Bloque base para todos los demás workers. | n/a | persist `opportunities`+`contacts`+`sync_state` |
| `refresh-meta-token` | cron diario 3am CST | **inline** (utility puro) | — | Token OAuth refresh. Cero LLM. Operacional crítico. | n/a | persist `secrets`; (futuro) emitir `META_TOKEN_REFRESHED` para notif |
| `batch-auto-prompt` | event `CAMPAIGN_BATCH_VARIANT_REQUESTED` (experimental) | **agent: creativo** | `creativo` task=`ad` (o nuevo task=`variants_batch`) | El propósito exacto del function (N variantes con ángulos distintos en paralelo) es literalmente la misión del Creativo (`generateAdAngles` ya devuelve 3 ángulos por pipeline). El fan-out N→variantes en Inngest da checkpointing; cada `step.run('claude-variant-X')` debe invocar `executeCreativoOnDemand({ task: 'ad', params: { pipelineId, performanceContext, angle } })` con un solo ángulo por step. | `{ task: 'ad', params: { pipelineId: pipeline_id, period, performanceContext: { stage_name, angulo } } }` por step | persist `auto_prompt_variants`; status=`draft` heredado del agente |

### Resumen visual (cardinalidad)

```
inngest/functions/        agents/
─────────────────────     ──────
scan-reactivations   ──► (utility)
send-reactivation    ──► creativo (Fase 3)        + emite LEAD_REACTIVATION_SENT
run-microseg         ──► analista (segundo paso)  + persist segmentations
run-arbitraje        ──► optimizacion             + emite CAMPAIGN_FATIGUE_DETECTED
distill-conversation ──► (utility)
sync-wapify-cache    ──► (utility, base layer)
refresh-meta-token   ──► (utility)
batch-auto-prompt    ──► creativo (task=ad)       + persist auto_prompt_variants
```

---

## 3. Reemplazo de motores legacy `api/*.js`

| Function | Reemplaza endpoint legacy | Estado migración | Notas |
|---|---|---|---|
| `scan-reactivations` + `send-reactivation` | `/api/reactivation-check` (cron actual Vercel) | A migrar | Cuando el flujo Inngest esté estable, desactivar el cron de `/api/reactivation-check` en `vercel.json`. **No borrar el archivo aún** (rollback rápido). |
| `run-microseg` | `/api/microseg` POST manual | A migrar parcial | Mantener `/api/microseg` GET (status) como sigue; reemplazar POST por `inngest.send({ name: SEGMENTATION_REQUESTED })`. |
| `run-arbitraje` | `/api/arbitraje` POST | A migrar parcial | Igual patrón: GET sigue, POST se vuelve emisor de evento. |
| `batch-auto-prompt` | `/api/auto-prompt` (si existe) o feature nueva | Sin conflicto detectado | `api/auto-prompt.js` no aparece en el listado de `api/` actual, así que es feature nueva via Inngest. Verificar con Isaac. |
| `distill-conversation` | (ninguno) | Nueva capability | No hay endpoint legacy equivalente. |
| `sync-wapify-cache` | (parcial) `/api/state`, `/api/pipeline-summary` | Sin conflicto | Estos endpoints leen Wapify on-demand. Tras migración, leerán de Supabase espejo (rápido) en vez de Wapify (lento + rate-limited). |
| `refresh-meta-token` | (ninguno) | Nueva capability | Hoy se hace manual con curl. Crítico para que `run-arbitraje` no muera al día 60. |
| `send-reactivation` (Fase 3) | (parcial) `/api/copiloto` | Convivencia | El dashboard sigue usando `/api/copiloto` para el vendedor humano (uso #5 — Copiloto Sales). El function `send-reactivation` es uso bot automático. **NO unificar todavía.** |

---

## 4. Gaps identificados

### 4.1 Agentes sin function Inngest que los invoque

| Agente | ¿Tiene function? | Estado | Recomendación |
|---|---|---|---|
| **analista** | Indirecto (vía `run-microseg`) | OK para start, pero el daily run principal del Analista (8am, 5 pipelines) no tiene wrapper Inngest. | **Crear `inngest/functions/run-analista-daily.js`**: cron `TZ=America/Tijuana 0 7 * * *` (1h antes de microseg) que invoque `executeAnalistaDailyRun({ period: 'last_24h' })`. Output → tabla `analista_insights` + emite `ANALYST_INSIGHT_EMITTED` (nuevo evento). |
| **qa** | NINGUNA | Hoy QA solo corre on-demand desde CLI/tests | **Crear `inngest/functions/run-qa-daily.js`**: cron `TZ=America/Tijuana 0 5 * * *` (madrugada, antes que cualquier cron diurno). Si `summary.blockers > 0`, emite `QA_BLOCKER_DETECTED` que para deploys/aprobaciones. |
| **creativo** | Indirecto (vía `batch-auto-prompt`, `send-reactivation` Fase 3) | OK | Dashboard usa on-demand. No requiere cron propio. |
| **optimizacion** | Indirecto (vía `run-arbitraje`) | OK para budget, pero `executeOptimizacionDailyRun` cubre más que arbitraje (segmentation, copy, angles) | **Crear `inngest/functions/run-optimizacion-daily.js`**: cron `TZ=America/Tijuana 30 7 * * *` (después del Analista, antes que microseg). Lee output del Analista de Supabase y propone cambios. |
| **desarrollador** | NINGUNA | Hoy on-demand desde QA o humano | **OK que sea on-demand** — pero crear `inngest/functions/handle-qa-blocker.js` que escuche `QA_BLOCKER_DETECTED` y dispare `desarrollador` task=`analyze_qa_failure`. Solo se activa si Isaac decide auto-triage. Ver §5 decisión D3. |
| **orquestador** | NINGUNA | Hoy on-demand | **OK que sea on-demand**, pero gaps importantes:<br>- Cron P2 escalation (humano sin atender > 30min) → mencionado en TODO de `agents/orquestador/index.js`. Function nueva: `inngest/functions/escalate-stale-approvals.js`, cron `*/10 * * * *`.<br>- `share_context` debería disparar tras `ANALYST_INSIGHT_EMITTED` para repartir al Creativo/Optimizacion. |

**Conclusión gaps:** faltan al menos **5 functions nuevas** que conectan agentes al bus (no son blockers de Frente C, pero deben quedar en backlog Fase 2C).

### 4.2 Conflictos function vs. endpoint `/api/*`

| Conflicto | Resolución propuesta |
|---|---|
| `run-microseg` (Inngest) vs `/api/microseg` POST | Mantener ambos durante Fase 2; deprecar POST cuando Inngest pase QA. GET sigue para dashboard. |
| `run-arbitraje` (Inngest) vs `/api/arbitraje` POST | Igual: convivencia, deprecar POST. |
| `send-reactivation` Fase 3 (creativo) vs `/api/copiloto` | NO unificar. `/api/copiloto` sigue para el vendedor humano (uso ≠ bot). |
| `sync-wapify-cache` (Inngest cada 15min) vs lecturas on-demand desde `/api/state` y `/api/pipeline-summary` | Tras migración, los endpoints leen del espejo Supabase, no de Wapify directo. Reduce ~80% del tráfico a Wapify. Requiere refactor de `/api/state.js` y `/api/pipeline-summary.js` (no incluido en Frente C base, dejar para Fase 2C). |

---

## 5. Decisiones que requieren input Isaac (NO decidir aquí)

### **D1. Migración `send-reactivation` → Creativo: ¿cuándo?**

- **A)** Big-bang en Frente C: reemplazar copiloto inline por `executeCreativoOnDemand({ task: 'reactivation' })` desde el día 1.
  - Pro: arquitectura limpia, un solo lugar genera reactivaciones.
  - Contra: rompe el flujo si Creativo tiene bug; Creativo bloquea por `requires_approval: true` y eso traba el envío automático.
- **B)** Convivencia 30 días: function llama copiloto inline por defecto, flag `USE_CREATIVO_AGENT=true` activa el path nuevo en sombra (logging only). Comparar outputs.
  - Pro: zero-risk, observabilidad.
  - Contra: doble código durante un mes.
- **C)** Diferir Fase 3: function se queda inline durante toda Fase 2; migración a Creativo es proyecto separado tras QA daily.
  - Pro: máximo aislamiento; Frente C entrega valor sin tocar producción.
  - Contra: queda deuda técnica explícita.

**Recomendación arquitecto:** B. Es el balance riesgo/aprendizaje.

### **D2. ¿`requires_approval` del Optimizacion bloquea `run-arbitraje`?**

Cuando `run-arbitraje` invoca al Optimizacion y este emite una propuesta con `estimated_delta_usd > 50`, esa propuesta queda en `pending_approvals`. **¿Qué hace el function?**

- **A)** Persistir propuesta y emitir `CAMPAIGN_FATIGUE_DETECTED` igual. Humano aprueba en dashboard. Sin bloqueo.
- **B)** Pausar el flujo: no emitir `CAMPAIGN_FATIGUE_DETECTED` hasta que humano apruebe.
- **C)** Auto-aprobar si `estimated_delta_usd <= $100` y horario es 9am-6pm. Resto cola humana.

**Recomendación arquitecto:** A. La aprobación es para EJECUTAR el cambio en Meta, no para reportarlo. La fatiga es info pública.

### **D3. ¿Auto-triage QA → Desarrollador?**

Si QA daily detecta blocker, ¿el sistema dispara automáticamente al Desarrollador para analizarlo?

- **A)** Sí, full pipeline: `QA_BLOCKER_DETECTED` → desarrollador `analyze_qa_failure` → emite PR stub → Isaac revisa por la mañana.
- **B)** Solo si `severity != critical` y `confidence > 0.6` del Desarrollador. Críticos esperan a humano.
- **C)** No. QA notifica a Isaac (Slack/email) y Desarrollador solo se invoca a mano.

**Recomendación arquitecto:** B. Reduce ruido pero permite que el agente trabaje de noche en fixes triviales.

### **D4. Modelo del cron Analista vs cron microseg**

Hoy `run-microseg` es 8am CST con análisis Claude inline. Si creamos `run-analista-daily` a las 7am, ¿microseg sigue corriendo análisis inline o se vuelve solo clasificación + persist y deja el insight al Analista?

- **A)** Separación pura: microseg = clasificador determinista (sin LLM). Analista lee `segmentations` y emite insights.
- **B)** Microseg sigue con análisis inline (status quo). Analista hace análisis cross-pipeline (visión global), no por-segmento.
- **C)** Microseg corre como hoy, pero el Analista se suscribe a su output y agrega meta-análisis encima.

**Recomendación arquitecto:** C. Es evolutivo, no rompe contratos actuales.

### **D5. ¿Dónde vive el wrapper `inngest.createFunction` por agente?**

- **A)** Dentro de `agents/{X}/index.js`: cada agente exporta su Inngest function nativa.
  - Pro: locality. Contra: agentes dependen de `client.js` Inngest.
- **B)** Dentro de `inngest/functions/run-{agent}-daily.js`: capa de transporte separada.
  - Pro: agentes siguen siendo módulos planos testeables. Contra: dos lugares para entender el ciclo de vida.
- **C)** Dentro de `inngest/wrappers/{agent}.js`: nueva carpeta dedicada solo a Inngest-wrappers, sin lógica.
  - Pro: separación quirúrgica. Contra: una carpeta más.

**Recomendación arquitecto:** B (mismo patrón que ya está en `inngest/functions/run-arbitraje.js`, `run-microseg.js`).

---

## 6. Roadmap de wiring (orden de implementación Frente C)

### Wave 0 — Pre-flight (sin cambios funcionales)
1. Confirmar `_shared/db.js` exporta `logAgentRun`, `publishAgentMessage`, `readAppConfig`, `readKnowledgeBase`, `readPendingApprovals`. Hoy los `pingSupabase` los importan dinámicamente. Convertir a static import en cada `index.js` (5min cada uno).
2. Crear `inngest/wrappers/` o reusar `inngest/functions/` para los wrappers nuevos. (depende D5)

### Wave 1 — Utility puros (mecánicos, sin agentes) [~4-6h]
Estos no requieren decisión de Isaac. Reemplazar stubs por lógica real copiada de `/api/*`.

1. `sync-wapify-cache.js` — bloque base. Sin esto, los demás workers operan a ciegas o golpean Wapify directo.
2. `refresh-meta-token.js` — crítico operacional. Implementación 30min (es solo un GET a graph.facebook.com + UPSERT).
3. `distill-conversation.js` — útil para el dashboard de leads históricos. Independiente de los demás.

### Wave 2 — Functions que llaman LEGACY inline (sin agentes todavía) [~6-8h]
Reemplazar stubs por las funciones equivalentes de `/api/*.js`. Sigue siendo migración mecánica.

4. `scan-reactivations.js` — copiar lógica de `/api/reactivation-check.js` (`getRecentLeads` + `needsReactivation`).
5. `send-reactivation.js` — POST inline a `/api/copiloto` (sin Creativo aún, decisión D1).
6. `run-microseg.js` — copiar `classify()` + `STAGE_POSITION` + llamada Claude de `/api/microseg.js`.
7. `run-arbitraje.js` — copiar `scoreCampaigns()` + llamada Claude de `/api/arbitraje.js`.
8. `batch-auto-prompt.js` — implementar contexto + N llamadas Claude paralelas.

### Wave 3 — Wiring con agentes (requiere agentes en runtime) [~8-12h]
Aquí entran los agents. Hacer detrás de feature-flag por function.

9. `run-arbitraje` ahora invoca `optimizacion` para propuestas (en vez de Haiku inline). Feature flag `USE_OPTIMIZACION_AGENT=true`.
10. `batch-auto-prompt` invoca `creativo` task=`ad`. Feature flag `USE_CREATIVO_FOR_VARIANTS=true`.
11. `run-microseg` invoca `analista` para meta-análisis cross-segment (decisión D4·C). Feature flag `USE_ANALISTA_POST_MICROSEG=true`.

### Wave 4 — Nuevas functions de agentes [~6-10h]
12. `run-analista-daily.js` (cron 7am CST) — gap §4.1.
13. `run-qa-daily.js` (cron 5am CST) — gap §4.1.
14. `run-optimizacion-daily.js` (cron 7:30am CST) — gap §4.1.
15. `handle-qa-blocker.js` (event `QA_BLOCKER_DETECTED`) — depende decisión D3.
16. `escalate-stale-approvals.js` (cron `*/10 * * * *`) — orquestador.

### Wave 5 — Decisiones pendientes Isaac (NO empezar hasta tener input)
17. Decisión D1 → migrar `send-reactivation` a Creativo (path A/B/C).
18. Decisión D2 → ajustar bloqueo de fatigue events.
19. Decisión D3 → activar auto-triage QA→Desarrollador.

### Wave 6 — Limpieza
20. Deprecar `/api/microseg` POST, `/api/arbitraje` POST, cron de `/api/reactivation-check` en `vercel.json`. Dejar archivos en `api/_backup/`.
21. Refactor `/api/state`, `/api/pipeline-summary` para leer de Supabase espejo (no Wapify directo).

---

## 7. Resumen ejecutivo para Frente C

- **8 functions, 3 categorías:**
  - 3 utilities puros (sync, refresh-token, distill) → Wave 1.
  - 3 reemplazos de motor legacy con LLM inline (scan-react+send-react, microseg, arbitraje) → Wave 2.
  - 2 con vocación de agente (arbitraje→opt, batch-auto-prompt→creativo) → Wave 3.
- **5 functions nuevas a crear** para cerrar gaps de agentes (analista-daily, qa-daily, opt-daily, qa-blocker, escalate-approvals) → Waves 4.
- **5 decisiones bloqueantes** para Isaac antes de Waves 5 (D1-D5 arriba).
- **Path crítico Frente C base:** Wave 0 → 1 → 2 (todo sin agentes, ~14h). Después se itera agentes encima sin tocar el transporte.
- **No tocar `/api/copiloto`** — uso humano vendedor sigue intacto.

---

## Anexo — eventos pendientes de promover

`EVENTS_EXPERIMENTAL.CAMPAIGN_BATCH_VARIANT_REQUESTED` se usa en `batch-auto-prompt.js`. Si se promueve al catálogo canónico (`EVENTS`), actualizar `inngest/events.js` y el doc Sprint 4 GIOCORE v10.

Eventos sugeridos nuevos (no canónicos hoy):
- `ANALYST_INSIGHT_EMITTED` — emitido por `run-analista-daily`, consumido por orquestador (share_context).
- `QA_BLOCKER_DETECTED` — emitido por `run-qa-daily`, consumido por `handle-qa-blocker` y notifs.
- `META_TOKEN_REFRESHED` — emitido por `refresh-meta-token`, consumido por notif admin.
- `APPROVAL_PENDING_STALE` — emitido por `escalate-stale-approvals`, consumido por orquestador.

---

*Fin del doc — listo para revisión Isaac.*
