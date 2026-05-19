# Frente C · Plan v2 (revisado tras audit Agent E + fix Code f1a6f13)

> **Status:** Draft arquitectural. Generado 18 may 2026 (noche tardía) por arquitecto senior.
> **Reemplaza:** Plan Frente C v1 (C.0–C.5) del reporte maestro Parte 5.
> **Origen del cambio:** Audit `inngest/` por Agent E + verificación de estado real (`inngest` no instalado, handler stub, `client.js` inerte, 3 shapes en circulación).
> **Pre-condición ya satisfecha:** Smoke ESM 6/6 verde + `sim-agents.mjs` 12/12 runs verde (commit `f1a6f13`).

---

## 1. Diff vs plan v1

### 1.1 Pasos del v1 que siguen vigentes (sin cambios)

| v1 | Sigue vigente porque |
|---|---|
| **C.1 LangGraph wiring** | Los 6 agents/ ya están operativos y publican al bus con shape correcto post-fix (P0-3). El wiring de LangGraph dentro de cada graph.js no depende de Inngest. |
| **C.3 Panel aprobaciones live** | El panel consume el bus in-memory hoy; cuando subamos a Supabase será cambio de transporte, no de UX. Independiente de Inngest. |
| **C.4 Smoke shadow Analista** | El shadow del Analista NO requiere Inngest — corre como invocación directa de `executeAnalistaDailyRun`. Independiente. |
| **C.5 Cierre y handoff** | Procedimiento de cierre genérico, vigente. |

### 1.2 Pasos del v1 que requieren cambios

| v1 | Cambio requerido |
|---|---|
| **C.0 Pre-flight (~30 min)** | Se sube a ~2-3h. Ya no es solo "verificar env vars y smoke": ahora absorbe los 9 sub-pasos C.0.1–C.0.9 de Agent E (instalar SDK, mover handler stub a `api/inngest.js`, reemplazar client stub, normalizar `step.sendEvent ?? inngest.send`, cerrar duplicado del cron, unificar shape bus/inngest). Sin esto, C.1+ no puede correr. |
| **C.2 Inngest events (~1-2h)** | Se sube a ~3-4h. v1 asumía que las 8 `inngest/functions/*` ya estaban wireadas a `agents/`. **No lo están** — son stubs que `console.log` y devuelven objetos vacíos. Cada function debe llamar al agent correspondiente (decisión arquitectural pendiente §3). |
| **C.4 Smoke shadow Analista** | Pre-requisito nuevo: que `runAnalista` sea idempotente bajo Inngest (mismo `correlation_id` ⇒ mismo resultado, no doble cobro Anthropic). Hoy lo es a nivel agent pero no a nivel orquestación. |

### 1.3 Pasos nuevos a agregar (9 del Agent E + 3 propios)

Sub-fase **C.0 expandida**:

| Sub-paso | Origen | Resumen |
|---|---|---|
| C.0.1 | Agent E | `npm i inngest` + lock |
| C.0.2 | Agent E | Reemplazar stub de `inngest/client.js` por `new Inngest({ id:'giolens', eventKey })` real |
| C.0.3 | Agent E | Crear `api/inngest.js` (mover contenido de `api-handler-stub.js`, descomentar `serve` de `inngest/next`) |
| C.0.4 | Agent E | Añadir env vars `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` a Vercel (Production + Preview) |
| C.0.5 | Agent E | Eliminar el patrón `step.sendEvent?.() ?? await inngest.send()` en `scan-reactivations.js` (rompe idempotencia: si `step.sendEvent` existe pero falla, cae al fallback duplicando) |
| C.0.6 | Agent E | Decidir y migrar cron `*/5 * * * *` de `vercel.json` (hoy apunta a `/api/webhook?mode=cron`) — colisiona con cron interno de `scan-reactivations` (`*/5 * * * *` también) |
| C.0.7 | Agent E | Unificar shape único entre `bus.js` (campos `from_agent/to_agent/type/payload`) e `inngest events.js` (`name`+`data.correlation_id`) — decisión arquitectural §3 |
| C.0.8 | Agent E | Decidir destino del experimental `CAMPAIGN_BATCH_VARIANT_REQUESTED` (promover a `EVENTS` o descartar `batch-auto-prompt.js`) §3 |
| C.0.9 | Agent E | Smoke local con `inngest-cli dev` antes de wirear functions a agents (verifica registro de las 8 funciones) |
| **C.0.10** | **Nuevo (arquitecto)** | Validar que `vercel.json` declare `api/inngest.js` con `maxDuration: 300` (Inngest steps individuales pueden exceder 60s) — hoy no está |
| **C.0.11** | **Nuevo (arquitecto)** | Añadir `inngest/events.js` validator helper (`makeEvent(name, payload)`) que enforce `correlation_id` obligatorio — hoy se documenta pero no se valida |
| **C.0.12** | **Nuevo (arquitecto)** | Ajustar `webhook.js` para emitir `LEAD_MESSAGE_RECEIVED` en paralelo a su flujo síncrono (coexistencia, no reemplazo) — `webhook.js` es el único entrypoint Wapify y no se puede tocar sin coordinar |

### 1.4 Pasos que pueden eliminarse o postergarse

| v1 | Decisión |
|---|---|
| Smoke "fire `segmentation.requested` desde Inngest dashboard" dentro de C.2 | **Posterga a C.4 ampliado**, después de que `run-microseg` ya llame a `agents/optimizacion`. Antes no demuestra nada. |
| Verificación de cron `*/15` `sync-wapify-cache` en C.0 | **Posterga a Frente D** (depende de Supabase real, no de Inngest). Hoy `sync-wapify-cache.js` es stub puro. |

---

## 2. Plan v2 estructurado

### Resumen ejecutivo

- **Duración total v2:** **9-12h** (vs 5.5-8h del v1) — overhead **+3-4h** mayormente en C.0 expandido y C.2 con wiring real a agents.
- **Camino crítico:** C.0 → C.2 → C.4. C.1 y C.3 son paralelizables si hay dos cabezas.
- **Pre-requisito global:** commit `f1a6f13` en `main` o branch base. Cuenta Inngest creada (manual, 5 min externos, no contabilizados).

---

### Fase C.0 — Pre-flight expandido (~2-3h)

**Pre-req:** `f1a6f13` en local. Cuenta Inngest creada. Acceso a Vercel env vars.

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.0.1 | `npm i inngest` + commit lock | `inngest` en `package.json` dependencies; `package-lock.json` o `pnpm-lock.yaml` actualizado | 5 min |
| C.0.2 | Reemplazar stub en `inngest/client.js` por SDK real | `import { Inngest } from 'inngest'` + `new Inngest({...})`; `node --check inngest/client.js` pasa | 10 min |
| C.0.3 | Crear `api/inngest.js` (mover de `api-handler-stub.js`, descomentar `serve`) | `GET /api/inngest` devuelve 200 con manifest de 8 funciones en dev local | 15 min |
| C.0.4 | Env vars en Vercel (Prod + Preview): `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | `vercel env ls` muestra ambas en ambos scopes | 10 min |
| C.0.5 | Quitar fallback `step.sendEvent ?? inngest.send` en `scan-reactivations.js` (líneas 64-87): solo `step.sendEvent` | Una sola ruta de emisión; lint pasa | 15 min |
| C.0.6 | Migrar cron `*/5 * * * *` (decisión §3.3): retirar de `vercel.json` o renombrar | Solo un cron `*/5` activo en el sistema (no doble scan) | 15 min |
| C.0.7 | Unificar shape (decisión §3.4): adapter en `agents/_shared/inngest-bridge.js` que traduzca bus.js ↔ inngest event | `bus.publish(...)` también emite Inngest event si `process.env.INNGEST_EVENT_KEY` | 30 min |
| C.0.8 | Decisión §3.2 sobre `EVENTS_EXPERIMENTAL`: promover o eliminar `batch-auto-prompt.js` | `events.js` consistente con `api-handler-stub.js` exports | 15 min |
| C.0.9 | Smoke `npx inngest-cli@latest dev` local | Las 8 funciones aparecen registradas en dashboard local; ping manual de `segmentation.requested` ejecuta el stub | 20 min |
| C.0.10 | Añadir `api/inngest.js` a `vercel.json` con `maxDuration: 300` | `vercel.json` válido (`vercel build` no falla) | 5 min |
| C.0.11 | Helper `makeEvent(name, payload)` en `inngest/events.js` que rechaza payload sin `correlation_id` | Test unitario verde | 15 min |
| C.0.12 | `webhook.js` emite `LEAD_MESSAGE_RECEIVED` además de flujo síncrono | Webhook devuelve mismo response que hoy; Inngest dashboard recibe el evento | 20 min |

**Salida de C.0:** Inngest operativo end-to-end con functions stubeadas pero registradas; webhook emite eventos; bus y inngest comparten correlation_id.

---

### Fase C.1 — LangGraph wiring (~2-3h) — sin cambios sustantivos

**Pre-req:** C.0 verde.

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.1.1 | Asegurar que cada `agents/*/graph.js` exporta `run<Agent>` con firma `({input, context}) ⇒ {output, cost_usd, latency_ms}` | 6/6 exports verificados | 30 min |
| C.1.2 | `agents/_shared/run-with-trace.js`: wrapper que añade `correlation_id` propagado en bus y returna `{ result, trace }` | Smoke: 1 run de Analista produce `trace.steps[]` no vacío | 1h |
| C.1.3 | Validar que `bus.publish` se llama exactamente 1 vez por agent run (no duplicados) | `sim-agents.mjs` 12/12 sigue verde tras el cambio | 30 min |
| C.1.4 | Actualizar `agents/orquestador` para reaccionar a `resolve_conflict` con payload Inngest-compatible | Smoke con 2 propuestas conflictivas resuelve sin duplicar bus events | 1h |

**Salida de C.1:** LangGraph runs son auditables (trace) y emiten 1 solo evento por run.

---

### Fase C.2 — Wiring Inngest functions ↔ agents (~3-4h) — EXPANDIDA

**Pre-req:** C.0 + C.1 verdes. Decisión §3.1 tomada (qué function llama a qué agent).

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.2.1 | `run-microseg.js` step 2 (`claude-analysis-*`) llama a `agents/optimizacion.executeOptimizacion({pipeline_id})` en lugar de stub | 1 dispatch real de `segmentation.requested` produce filas en Supabase (cuando aplique) o log estructurado | 45 min |
| C.2.2 | `run-arbitraje.js` step `claude-analysis` llama a `agents/analista.executeAnalistaDailyRun({period:'last_6h'})` | Idem; cost_usd > 0 en log | 30 min |
| C.2.3 | `scan-reactivations.js` step `scan-pipeline-*` llama a `agents/creativo` para generar script reactivación (decisión §3.1) | 1 candidato → 1 evento `lead.silence_detected` con `script_preview` poblado | 45 min |
| C.2.4 | `send-reactivation.js` consume `lead.silence_detected` e invoca `agents/creativo.sendReactivation({contact_id, script})` con jitter | Smoke dry-run: log con `wapify_payload` correcto, `sent_at` poblado, `dry_run: true` | 45 min |
| C.2.5 | `distill-conversation.js` llama a `agents/analista.distillBatch(contact_ids)` | Smoke 5 contactos → 5 filas en `conversations_distilled` (stub o real) | 30 min |
| C.2.6 | Smoke E2E: `npx inngest-cli dev` + curl webhook → flow completo `message_received → silence_detected → reactivation_sent` con dry_run | Las 3 invocaciones aparecen en dashboard, mismo `correlation_id`, sin errores | 30 min |
| C.2.7 | Validar idempotencia: re-disparar `segmentation.requested` con mismo `correlation_id` → no doble cobro Anthropic | Log muestra `idempotent_skip` o equivalente | 30 min |

**Salida de C.2:** 5 de 8 functions llaman a agents reales. `refresh-meta-token`, `sync-wapify-cache`, `batch-auto-prompt` quedan en stub si decisión §3.2 las posterga.

---

### Fase C.3 — Panel aprobaciones live (~1-1.5h) — sin cambios

**Pre-req:** C.1 verde (no depende de C.2).

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.3.1 | Suscribir UI a `bus.subscribe('panel-aprobaciones', handler)` | Mensaje publicado en bus aparece en UI < 200ms | 30 min |
| C.3.2 | Botones Approve/Reject emiten al bus con `from_agent: 'panel'` | E2E: approval llega a orquestador y se ve `resolve_conflict` resuelto | 30 min |
| C.3.3 | Render histórico (últimos 20 mensajes) | UI poblada al cargar | 30 min |

---

### Fase C.4 — Smoke shadow Analista (~45 min-1h) — refinada

**Pre-req:** C.1 + C.2 verdes (o al menos C.2.2 = run-arbitraje wireado).

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.4.1 | Disparar `executeAnalistaDailyRun({period:'last_24h'})` desde script local (sin Inngest) | Log estructurado con `insights_count > 0`, `cost_usd > 0`, `errors: []` | 15 min |
| C.4.2 | Disparar mismo run vía `inngest.send({name: ARBITRAGE_REQUESTED})` | Dashboard Inngest muestra run completo; cost_usd reportado en step output | 20 min |
| C.4.3 | Comparar outputs (shadow vs Inngest): diff = ∅ excepto timestamps | Diff verificado a mano (o script) | 15 min |
| C.4.4 | Verificar idempotencia: re-disparo con mismo `correlation_id` → skip o resultado idéntico | Log explícito | 10 min |

---

### Fase C.5 — Cierre y handoff (~30-45 min) — sin cambios

| # | Tarea | Criterio de éxito | Tiempo |
|---|---|---|---|
| C.5.1 | Actualizar `MEMORY.md` y `project_giolens_fases.md` con estado Frente C cerrado | Notas dueño-confirmadas | 15 min |
| C.5.2 | Commit + tag `frente-c-v2-done`; PR si aplica | Pipeline CI verde | 15 min |
| C.5.3 | Handoff doc: qué functions quedan en stub, qué decisiones se difirieron | `docs/frente_c_v2_handoff.md` con TODOs explícitos | 15 min |

---

## 3. Decisiones pendientes (el plan v2 NO puede tomar solo)

### 3.1 Wiring Inngest functions ↔ agents (arquitectural)

**Pregunta:** ¿Qué function de `inngest/functions/` llama a qué agent de `agents/`?

Propuesta baseline para decisión:

| Function | Agent (propuesto) | Alternativa | Quien decide |
|---|---|---|---|
| `scan-reactivations` | `agents/creativo` (genera script) | `agents/optimizacion` (decide si vale enviar) | Isaac |
| `send-reactivation` | `agents/creativo` (dispatch Wapify) | wrapper en `api/copiloto.js` (legacy coexistencia) | Isaac |
| `run-microseg` | `agents/optimizacion` | `agents/analista` | Isaac |
| `run-arbitraje` | `agents/analista` | `agents/optimizacion` | Isaac |
| `distill-conversation` | `agents/analista` | nuevo agent | Isaac |
| `sync-wapify-cache` | n/a (infra, no agent) | — | Isaac |
| `refresh-meta-token` | n/a (infra) | — | Isaac |
| `batch-auto-prompt` | `agents/creativo` | descartar (§3.2) | Isaac |

**Bloquea:** C.2 entero. Sin esto C.2.* son stubs.

### 3.2 Promoción/descarte de `CAMPAIGN_BATCH_VARIANT_REQUESTED`

**Pregunta:** ¿`batch-auto-prompt.js` se promueve a producción (mover `CAMPAIGN_BATCH_VARIANT_REQUESTED` de `EVENTS_EXPERIMENTAL` a `EVENTS`) o se descarta y elimina la function?

Opciones:
- **A. Promover:** wirear a `agents/creativo`, exponer trigger desde dashboard. +1h C.2.
- **B. Descartar:** eliminar `batch-auto-prompt.js` y `EVENTS_EXPERIMENTAL`. Reducir superficie. Endpoint `/api/auto-prompt` único.
- **C. Diferir a Frente D:** mantener stub, no wirear, documentar.

**Recomendación arquitecto:** C (diferir). El `/api/auto-prompt` síncrono cubre el caso hoy.

### 3.3 Cron `*/5` actual: cutover vs dual-write

**Pregunta:** `vercel.json` cron `*/5 * * * *` → `/api/webhook?mode=cron` (lógica de `reactivation-check`) colisiona con `scan-reactivations.js` (mismo `*/5`).

Opciones:
- **A. Cutover inmediato:** retirar entrada de `vercel.json`. Riesgo: si Inngest cae, no hay reactivaciones.
- **B. Dual-write 2 sprints:** ambos corren, deduplicar por `correlation_id` en `agent_messages`. Costo: doble Anthropic.
- **C. Cutover con kill-switch:** retirar de `vercel.json`, dejar feature flag `LEGACY_REACTIVATION_CRON=true` que reactiva el endpoint si Inngest falla. **Recomendación arquitecto.**

**Bloquea:** C.0.6.

### 3.4 Shape unificado bus.js vs Inngest events

**Pregunta:** `bus.js` usa `{from_agent, to_agent, type, payload}`, `inngest/events.js` usa `{name, data: {correlation_id, ...}}`. ¿Cuál es canónico?

Opciones:
- **A. Adapter bidireccional:** mantener ambos, `agents/_shared/inngest-bridge.js` traduce. Bus sigue siendo interno; Inngest es transporte externo. **Recomendación arquitecto.**
- **B. Migrar bus a shape Inngest:** simplifica pero rompe `bus.js` y obliga a tocar los 6 agents.
- **C. Migrar Inngest a shape bus:** no idiomático; ignora convenciones del SDK.

**Bloquea:** C.0.7.

---

## 4. Riesgos nuevos (no contemplados en v1)

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Cron duplicado (`*/5` Vercel + `*/5` Inngest) cobra Anthropic 2x mientras se decide §3.3 | C.0.6 antes de C.2 obligatorio. Si no se decide en 30 min, kill-switch §3.3 C. |
| R2 | `step.sendEvent ?? inngest.send` (líneas 64-87 de scan-reactivations) puede emitir 2 eventos si Inngest tiene `step.sendEvent` definido pero throws — el fallback al `inngest.send` re-emite | C.0.5: refactor a `step.sendEvent` único. Si Inngest falla, deja que el retry policy lo maneje. |
| R3 | Webhook (`api/webhook.js`) es único entrypoint Wapify; emitir Inngest event ahí puede bloquear el ack a Wapify si `inngest.send` cuelga | C.0.12: emisión con `Promise.race` y timeout 2s; fallback a log para reproceso manual. |
| R4 | `correlation_id` no validado: hoy events.js lo documenta como obligatorio pero ningún emisor lo enforce | C.0.11: helper `makeEvent` que throws si falta. |
| R5 | Idempotencia entre runs Inngest (retries=1 en run-microseg) — sin clave de idempotencia explícita, retry re-cobra Anthropic | C.2.7: usar `step.run` con clave determinística `claude-analysis-{pipeline_id}-{correlation_id}` para que el SDK cachee. |
| R6 | Vercel `maxDuration: 60` default — algunos steps Inngest (batch claude variants, distill 50 contactos) pueden exceder. Inngest reintentos enmascararán fallos como "lentos" sin tocar root cause. | C.0.10: declarar `api/inngest.js` con `maxDuration: 300`. Monitorear durations > 120s en step output. |
| R7 | Promoción de `EVENTS_EXPERIMENTAL` sin documentar — si C.0.8 promueve sin actualizar `inngest/README.md` ni `events.js` JSDoc, queda inconsistente entre runtime y doc | C.0.8 incluye actualización doc obligatoria. |
| R8 | Frente C avanza con Inngest pero Supabase real no llega hasta Frente D — upserts son stubs. Si C.4 valida shadow contra "filas en Supabase", el criterio falla. | C.4 criterio ajustado a "log estructurado con cost_usd>0", no a filas Supabase. |

---

## 5. Costo adicional estimado vs v1

| Bloque | Costo extra | Razón |
|---|---|---|
| Instalar `inngest` + handler real | +30 min | C.0.1–C.0.3 |
| Env vars + verificación Vercel | +15 min | C.0.4 |
| Quitar fallback emit y migrar cron | +30 min | C.0.5–C.0.6 |
| Normalizar shapes (bridge bus ↔ inngest) | +1h | C.0.7 (decisión §3.4 A) |
| Decisión y limpieza experimental | +20 min | C.0.8 |
| Smoke local con `inngest-cli` | +20 min | C.0.9 |
| Hardening (`maxDuration`, `makeEvent` validator, webhook emit) | +40 min | C.0.10–C.0.12 |
| Wirear 5 functions a agents reales | +2h | C.2.1–C.2.5 (v1 asumía stubs ok) |
| Smoke E2E + idempotencia | +1h | C.2.6–C.2.7 |
| **Total overhead** | **+6-7h** | sobre los 5.5-8h del v1 |

Total v2 realista: **9-12h** (rango ancho por dependencia de decisiones §3.1 y §3.4).

---

## 6. Anexo: orden recomendado de decisiones (para Isaac, antes de arrancar C.0)

1. **§3.3 cron cutover** (5 min) — bloquea C.0.6
2. **§3.4 shape unificado** (10 min) — bloquea C.0.7, recomendación A
3. **§3.2 experimental** (5 min) — bloquea C.0.8, recomendación C (diferir)
4. **§3.1 wiring functions↔agents** (15-20 min, mesa de trabajo) — bloquea TODO C.2

Sin estas 4 decisiones, C.0 puede arrancar hasta C.0.5 (~45 min) pero se atasca después.
