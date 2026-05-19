# Update para Cowork · post-sesión Code 18 may noche tardía

**Para:** Cowork
**De:** Code (vía Isaac)
**Fecha:** 2026-05-18 noche tardía
**Versión Code:** 5 commits hoy · working tree clean · branch main ahead of origin/main by 9
**Acción solicitada:** actualizar reporte maestro Cowork ↔ Code ↔ Chat (v1.0) con los cambios documentados aquí. Mantener numeración Partes 1-9 actual.

---

## 1. Tareas Code (Parte 3 del reporte) — TODAS COMPLETADAS ✅

| Tarea | Estado | Evidencia |
|---|---|---|
| **Tarea 1 — Anexo B (15 tipos evento bus)** | ✅ DONE | `docs/anexos_B_C.md` · commit `9cd66dc` |
| **Tarea 2 — Anexo C (25 tools)** | ✅ DONE | mismo archivo · commit `9cd66dc` |
| **Tarea 3 — D4 verificación slots Vercel** | ✅ DONE | ver §1.1 abajo |

### 1.1 D4 — respuesta concreta (resolver Open Question del reporte)

- **Estado actual:** 10 functions en `api/` (arbitraje, copiloto, meta, microseg, pipeline-summary, predictor, state, text-utils, token-status, webhook) · 1 cron declarado.
- **Plan **Hobby** (legacy pre-2023):** límite 12 functions → este límite **NO aplica** al plan Pro.
- **Plan Pro (el nuestro):** sin cap de 12. Permite cientos de functions y hasta **100 crons**.
- **Frente C necesita ~2-3 functions adicionales** (api/inngest.js + handlers) → margen sobrado.
- **Conclusión:** NO se requiere upgrade a Pro+. **Ahorro estimado: ~$150 USD/mes**.

**Acción para Cowork:** cancelar item "evaluar upgrade Pro+" del decision log. Marcar D4 como ✅ Confirmado.

---

## 2. Hallazgo crítico no contemplado por Cowork — 17 P0 técnicos

La auditoría semántica de Cowork sobre `prompt.js` y artefactos de mensajería detectó **14 hallazgos**. En paralelo, Code corrió una auditoría arquitectural con **6 sub-agents especializados** sobre el código real (runtime, security, infra, observabilidad). Resultado: **17 P0 técnicos**, en su mayoría invisibles al audit semántico porque viven fuera de `prompt.js`.

**Los dos sets son complementarios, no redundantes.** Estimación de solapamiento: 5-7 issues. El resto son gaps que cada lado no podía ver.

### 2.1 Distribución por sub-agent

| Agent | Scope | P0 detectados | P0 resueltos hoy |
|---|---|---|---|
| A | `agents/` (6 agentes operativos) | 4 | 4 ✅ |
| B | `api/` security | 3 | 3 ✅ (código listo) |
| C | tests / coverage | 3 | 0 (pendientes) |
| D | sim harness builder | n/a (entregable) | `scripts/sim-agents.mjs` 12/12 verde |
| E | inngest | 6 | 0 (pendientes · plan v2) |
| F | `_shared/` profundo | 1 (P0-5 trackCost) | 1 ✅ |
| G | anexos B+C | n/a (entregable) | `docs/anexos_B_C.md` ✅ |
| Coherencia | cruce Cowork↔Code | análisis | (no commiteado) |

**Total:** 17 P0 · 8 cerrados · 9 pendientes (3 tests + 6 inngest).

---

## 3. Distribución P0 técnicos vs hallazgos Cowork

| Categoría | Cowork (semánticos) | Code (técnicos) | Notas |
|---|---|---|---|
| Total detectados | 14 | 17 | sets distintos |
| Solapamientos estimados | — | — | S1–S7 (~5-7) |
| Solo Cowork ve | ~7-9 | — | tono, copy, journey 3 interacciones, framing CPR, etc. |
| Solo Code ve | — | ~10-12 | runtime bus shape, env vars security, harness sim, schema inngest |
| Resueltos a hoy | (pendiente Plan B) | 8 | Code aplicó fixes inmediatos en agents/ + api/security |

**Ejemplos de gaps de cada lado:**

- **Solo Cowork:** desalineación CPR en mensajes outbound, journey de 3 interacciones no reflejado en prompts, framing portafolios Meta.
- **Solo Code:** `system→systemPrompt` en 12 sitios (agentes no arrancaban), `bus.publish` shape inconsistente (analista/qa rompían wiring), `CRON_SECRET` no enforced en `?mode=cron`, `WAPIFY_WEBHOOK_SECRET` ausente, `STATE_API_TOKEN` no gateado, `trackCost` perdía `cost_usd` en pipeline.

**Solapamientos esperados (S1-S7):** mocks Anthropic mal hechos (Cowork C.1.4 ↔ Agent C P1-1), refactor bus rompe agentes (Cowork C.2.5 ↔ resuelto en `f1a6f13`), smoke ESM rompe post-edit (Cowork C.0.5 ↔ ya verde).

---

## 4. Estado post-fixes Code (commits de hoy)

| Commit | Cierra |
|---|---|
| `f1a6f13` · fix(agents): 5 P0 R-19 BIS | `system→systemPrompt` en 12 sitios · `readKpis`/`readPipeline` default callable · `bus.publish` shape normalizado · `trackCost` preserva `cost_usd` |
| `9cd66dc` · docs+scripts | harness `scripts/sim-agents.mjs` (12/12 verde) + `docs/anexos_B_C.md` (15 eventos bus + 25 tools) |
| `5038926` · fix(api/security) | `CRON_SECRET` enforced en `/api/webhook?mode=cron` · `STATE_API_TOKEN` listo para activación gradual |
| `3b67484` · fix(api/security) | `WAPIFY_WEBHOOK_SECRET` listo (firma webhook) · plan Frente C v2 en `docs/frente_c_plan_v2.md` (251 líneas · 9-12h vs 5.5-8h v1) |
| `42b1346` · chore(scripts) | smoke E2E Sentry verificado · refuerzo `.gitignore` |

### 4.1 Smoke prod 4/4 verde — deploy `dpl_DE98ZbGAR361e2TbB75cJkdgRSxk`

| Endpoint | Resultado esperado | Resultado real |
|---|---|---|
| `POST /api/webhook` sin secret | 200 (bypass · env var no seteada aún) | 200 ✅ |
| `GET /api/webhook?mode=cron` sin Auth | 401 (CRON_SECRET enforced) | 401 ✅ |
| `POST /api/state` sin token | 200 (bypass · env var no seteada aún) | 200 ✅ |
| `GET /api/state` status | 200 | 200 ✅ |

**Interpretación:** los dos endpoints "200 sin secret" son por diseño — el código ya verifica el secret cuando la env var existe, pero la activación es **gradual** (ver §9). El gate de cron sí está vivo ya.

---

## 5. Implicaciones para Parte 7 — Plan B contingencias

Cowork pre-redactó Plan B para los **7 must-fix semánticos**. Esos siguen siendo válidos: si Chat regresa NO-GO, Code aplicará los deltas Cowork sobre `prompt.js` y artefactos.

**Aclaraciones clave para la Parte 7:**

1. **Los 5 P0 de Code en `agents/` son distintos a los 7 must-fix semánticos** — viven en otra capa. No competen al D1 Chat.
2. **Los P0 técnicos NO requieren autorización Chat** — son rol Code y ya están aplicados.
3. **Plan B sigue vigente sin modificación** para los 7 must-fix semánticos.
4. Recomendado **agregar nota** en intro de Parte 7: "Plan B cubre hallazgos semánticos. Hallazgos técnicos (P0 Code) se aplican sin pase Chat — ver Update 18 may noche tardía §4".

---

## 6. Implicaciones para Parte 5 — Plan Frente C

El plan v1 del reporte maestro estima **5.5-8h**. Code generó hoy el plan v2 en `docs/frente_c_plan_v2.md` que revisa a **9-12h** por:

- Wiring real de `inngest functions ↔ agents` (en v1 eran stubs).
- `npm i inngest` + crear `api/inngest.js` + handlers explícitos por evento.
- 6 P0 reales detectados por Agent E (no contemplados en estimación v1).
- Schema declaration de los 15 eventos del bus (cruza con Anexo B).

**Sub-pasos C.0.\*** del plan v2 cubren los 6 P0 inngest pendientes.

**Recomendación a Cowork:** dos opciones para Parte 5:
- **(A)** Reemplazar plan v1 por plan v2 (link a `docs/frente_c_plan_v2.md`).
- **(B)** Conservar v1 como "estimación optimista" y agregar v2 como "estimación realista post-auditoría".

Code prefiere **(A)** para evitar dos fuentes de verdad.

---

## 7. Implicaciones para Parte 9 — Pre-mortem

El pre-mortem Cowork ya identificó varios riesgos que la sesión Code de hoy **resolvió o validó**:

| Riesgo Cowork | Estado real post-sesión |
|---|---|
| **C.0.5** "Smoke ESM rompe post-edit" | ✅ Ya validado verde — smoke prod 4/4 OK |
| **C.2.5** "Refactor bus.js rompe agentes" | ✅ Bus shape normalizado en analista/qa (commit `f1a6f13`) |
| **C.1.4** "Mocks Anthropic mal hechos" | ⚠️ Coincide con Agent C P1-1 — sigue pendiente (parte de los 3 P0 tests pendientes) |

**Acción para Cowork:** marcar C.0.5 y C.2.5 como "mitigado". Dejar C.1.4 con nota cruzada a Agent C P1-1.

---

## 8. 9 P0 pendientes (todavía Code, NO Chat)

### 8.1 Tests / Coverage (3 P0 · Agent C)
- Mergear `package.json.proposed` → `package.json` (deps de test + scripts).
- Agregar GitHub Actions CI (workflow `.github/workflows/ci.yml`).
- Generar snapshots baseline de los 6 agentes (golden outputs para regresiones).

### 8.2 Inngest (6 P0 · Agent E)
- `npm i inngest` (dep no instalada aún).
- Crear `api/inngest.js` (endpoint serve).
- Wirear 6 functions ↔ 6 agentes (mapping evento → handler).
- Declarar schema de los 15 eventos del bus (cruza con Anexo B).
- Configurar Inngest Cloud (signing key + env vars).
- Smoke E2E con 1 evento real end-to-end.

**Todo está en `docs/frente_c_plan_v2.md` sub-pasos C.0.\*.**

---

## 9. Activación pendiente env vars (decisión Isaac)

Fix de código listo, falta **setear env vars + redeploy**:

| Env var | Endpoint impactado | Estado actual |
|---|---|---|
| `STATE_API_TOKEN` | `/api/state` (POST/GET) | ⏳ no seteada → endpoint sigue abierto |
| `WAPIFY_WEBHOOK_SECRET` | `/api/webhook` (POST) | ⏳ no seteada → endpoint sigue abierto |
| `CRON_SECRET` | `/api/webhook?mode=cron` | ✅ activa — gate vivo (smoke 401) |

**Razón de activación gradual:** evitar romper tráfico legítimo de Wapify mientras se coordina la rotación de secretos.

**Acción para Isaac (no Cowork):** decidir ventana de corte y setear ambas env vars en Vercel + redeploy.

---

## 10. Solicitud explícita a Cowork

Al actualizar el reporte maestro v1.0 → v1.1, por favor:

1. **Parte 3 (Tareas Code):** marcar Tareas 1+2+3 como DONE con sus commits/archivos.
2. **D4 (decision log):** ✅ Confirmado · NO upgrade Pro+ · cancelar item.
3. **Parte 5 (Frente C):** integrar plan v2 (recomendado opción A — reemplazar) · link a `docs/frente_c_plan_v2.md`.
4. **Parte 6 (Open Questions):** agregar **OQ-7** — "P0 técnicos vs P0 semánticos · gaps · ¿necesitamos un canal de sincronización recurrente entre Code y Cowork por sesión?".
5. **Parte 7 (Plan B):** agregar nota aclaratoria — Plan B cubre semánticos · técnicos se aplican sin pase Chat.
6. **Parte 9 (Pre-mortem):** marcar C.0.5 ✅ mitigado · C.2.5 ✅ mitigado · C.1.4 ⚠️ cruzar con Agent C P1-1.
7. **Anexos B+C:** ya disponibles en `docs/anexos_B_C.md` · Cowork puede pegar contenido o linkar.

---

## 11. Lo que NO cambia en el reporte maestro

- **Parte 1** (estado general) — sigue vigente.
- **Parte 2** (decision log) — sigue vigente salvo D4.
- **Parte 4** (briefing Chat) — los anexos B/C ya viven en `docs/anexos_B_C.md` · Cowork copia o linka.
- **Parte 8** (roadmap D-E-F) — sin cambios.

---

## ⚠️ Inconsistencias detectadas que Cowork debe revisar

1. **Branch ahead de origin/main:** Code está **9 commits ahead** de `origin/main`. Si el reporte maestro asume que todo está en remoto, está desactualizado. Decisión pendiente: ¿push ahora o esperar?
2. **`api/_backup/`:** existe un directorio `_backup` dentro de `api/` que el reporte maestro no menciona. No es serverless function (Vercel ignora directorios con `_` prefix), pero conviene aclararlo si Cowork inventaría functions.
3. **Conteo de functions:** Cowork mencionó "12 slots" en el contexto de límite Vercel. Reales: **10 functions activas** + `_backup` ignorado. El número correcto a citar es 10, no 12.
4. **Plan B vs P0 técnicos:** si Cowork escribió Plan B asumiendo que cubre "todo lo que pueda salir mal", conviene aclarar explícitamente que cubre solo el dominio semántico — para que Chat no piense que el Plan B también incluye contingencias de runtime.
5. **Estimación v1 Frente C (5.5-8h):** si Cowork ya comprometió esa estimación con Isaac o stakeholders, el salto a 9-12h del v2 necesita comunicación cuidadosa. Sugerencia: framing "estimación post-auditoría detectó 6 P0 inngest no visibles antes".
6. **Anexo B (15 eventos) vs schema inngest:** el Anexo B documenta 15 tipos de evento del bus. Cuando Code wire inngest (P0 pendientes §8.2), el schema declarado en inngest DEBE coincidir 1:1 con el Anexo B. Cowork debe agregar esta dependencia explícita en Parte 5.

---

*Fin del update. Generado por Code en sesión 18 may noche tardía. Archivo persistido en `docs/UPDATE_PARA_COWORK_18may_noche.md`.*
