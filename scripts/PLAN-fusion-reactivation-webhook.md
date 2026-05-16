# PLAN · Fusión `reactivation-check.js` → `webhook.js`

> **Estado:** diseño aprobado, ejecución diferida hasta que `conversation-intel.js` esté listo para entrar como 13° endpoint (Fase 3A operativa, post-Supabase).
> **Autor:** Code (sesión 16 may 2026)
> **Objetivo:** liberar 1 slot Vercel Hobby (12/12 → 11/12) preservando webhook reactivo + cron proactivo en un solo archivo.

## 1. Arquitectura propuesta

**Discriminador: query param `?mode=cron`** (declarativo en `vercel.json` `crons[].path`).

Trade-offs evaluados:
- **Header custom (`X-Vercel-Cron`)**: Vercel inyecta este header en invocaciones de cron, pero depende de implementación interna y no se puede testear con curl manual.
- **Path inspection (`req.url.includes('/cron')`)**: requiere rewrite, agrega complejidad.
- **Query param (`?mode=cron`)**: explícito, testeable con curl, sobrevive a refactors, declarable en `vercel.json`. **Elegida.**

Router top-level en el `default export`:

```js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isCron = req.query?.mode === 'cron'
              || req.headers['x-vercel-cron'] === '1';

  if (isCron) return handleReactivationCron(req, res);
  return handleWapifyWebhook(req, res);  // default = webhook
}
```

**Default = webhook** porque Wapify es el caller dominante (>1000 POST/día vs 288 cron/día) y no controla query params.

## 2. Cambios en `vercel.json`

```json
{
  "functions": {
    "api/pipeline-summary.js": { "maxDuration": 60 },
    "api/predictor.js":        { "maxDuration": 60 },
    "api/microseg.js":         { "maxDuration": 60 },
    "api/arbitraje.js":        { "maxDuration": 60 },
    "api/webhook.js":          { "maxDuration": 60 },
    "api/copiloto.js":         { "maxDuration": 60 },
    "api/auto-prompt.js":      { "maxDuration": 60 }
  },
  "crons": [
    { "path": "/api/webhook?mode=cron", "schedule": "*/5 * * * *" }
  ],
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/public/index.html" }
  ]
}
```

Cambios concretos:
- ELIMINAR entrada `"api/reactivation-check.js"` del bloque `functions`.
- AÑADIR bloque `crons` (no existía antes — el cron actual está configurado vía dashboard Vercel; este PR lo declara as-code).
- `webhook.js` ya tiene `maxDuration: 60` (cerrado el 16 may), suficiente para el cron.

## 3. Cambios en `webhook.js`

Estructura final:

```
// ─── HELPERS COMPARTIDOS ───
wapFetch, sendWAMessage, moveStage              (ya existen)
parseWapifyDate                                 (NUEVO, copiado de reactivation-check)
WAPIFY_TOKEN, WAPIFY_BASE                       (ya existen)

// ─── CONSTANTES WEBHOOK ───
MOTOR_MAP, TOOLS, MODEL, ANTHROPIC_KEY          (ya existen)
PROMPT_M1..M5, STAGES_*                         (ya existen)
motorJustinHolbrook..motorGioVision             (ya existen)
extractIds, callClaude, executeDecision         (ya existen)

// ─── CONSTANTES CRON (NUEVO) ───
TERMINAL_STAGES, PIPELINES, MIN/MAX_SILENCE_MS,
OPPORTUNITY_WINDOW_MS, MAX_SENDS_PER_RUN, DRY_RUN

// ─── HELPERS CRON (NUEVO) ───
getRecentLeads, needsReactivation,
getCopilotoScript, sendReactivationMessage

// ─── HANDLERS ───
async function handleWapifyWebhook(req, res)    (extraído del default actual)
async function handleReactivationCron(req, res) (extraído de reactivation-check)

// ─── ROUTER ───
export default async function handler(req, res) { ... }
```

**Refactor crítico — eliminar duplicación**:
- `wapGet`/`wapPost` del cron son redundantes con `wapFetch` del webhook. Reemplazar todas las llamadas del bloque cron por `wapFetch`.
- `WAPIFY_TOKEN` y `WAPIFY_BASE` ya están al top — borrar duplicados.

**Naming colision**: `sendMessage` del cron vs `sendWAMessage` del webhook. Mantener `sendWAMessage` (webhook), renombrar la del cron a `sendReactivationMessage` para preservar la rama `DRY_RUN`.

## 4. Cambios en `reactivation-check.js`

ELIMINAR el archivo completo después de validación. Antes: backup a `api/_backup/reactivation-check.js.bak-YYYYMMDD`.

## 5. Plan de migración paso a paso

| # | Acción | Comando | Reversible |
|---|--------|---------|------------|
| 0 | Verificar git status limpio | `git status` | — |
| 1 | Backup atómico | `mkdir -p api/_backup && cp api/reactivation-check.js api/webhook.js vercel.json api/_backup/` | sí |
| 2 | Smoke test PRE-fusión (baseline) | ver §6 | — |
| 3 | Editar `webhook.js` con código fusionado (router + handlers + helpers cron) | manual | sí (git revert) |
| 4 | Editar `vercel.json` (añadir `crons`, quitar entrada functions) | manual | sí |
| 5 | Deploy preview | `vercel` (NO `--prod`) | sí |
| 6 | Smoke test webhook en preview | ver §6 | — |
| 7 | Smoke test cron en preview | ver §6 | — |
| 8 | Deploy prod | `vercel --prod` | sí (vercel rollback) |
| 9 | Smoke test prod x3 (5min apart para ver cron real) | ver §6 | — |
| 10 | Esperar 1 ciclo cron natural + verificar `vercel logs` | `vercel logs --since 10m` | — |
| 11 | `git rm api/reactivation-check.js` + commit | manual | sí (git revert) |
| 12 | Deploy final | `vercel --prod` | sí |

**Punto de no-retorno:** paso 11. Antes, todo es `git revert`-able sin tocar Vercel.

## 6. Smoke tests

**PRE-fusión (baseline)** — capturar response shape para diff:
```bash
curl -s https://giolens-dashboard.vercel.app/api/webhook | jq . > /tmp/pre-webhook-get.json
curl -s https://giolens-dashboard.vercel.app/api/reactivation-check \
  | jq '{dry_run, total_sent, candidates: (.candidates|length)}' > /tmp/pre-cron.json
```

**POST-fusión (preview)**:
```bash
PREVIEW=https://giolens-dashboard-xxx.vercel.app

# 1. Webhook GET health
curl -s "$PREVIEW/api/webhook" | jq -e '.status=="ok" and (.motors|length)==5'

# 2. Webhook POST (payload mínimo, pipeline desconocido = ignored)
curl -sX POST "$PREVIEW/api/webhook" \
  -H 'Content-Type: application/json' \
  -d '{"pipeline_id":"999","contact_id":"test","message":"hola"}' \
  | jq -e '.received==true and .action=="ignored"'

# 3. Cron mode — debe devolver report con dry_run:true
curl -s "$PREVIEW/api/webhook?mode=cron" \
  | jq -e '.dry_run==true and (.pipelines|keys|length)==5'

# 4. /api/reactivation-check todavía responde (aún no borrado)
curl -s -o /dev/null -w "%{http_code}" "$PREVIEW/api/reactivation-check"  # 200

# 5. Diff de response cron
diff <(jq -S 'del(.started_at,.finished_at,.duration_ms)' /tmp/pre-cron.json) \
     <(curl -s "$PREVIEW/api/webhook?mode=cron" \
        | jq -S 'del(.started_at,.finished_at,.duration_ms,.pipelines.*.recent_leads)')
```

**Criterio de éxito:** tests 1-4 pasan, test 5 muestra estructura idéntica.

## 7. Rollback plan

Tres niveles, ordenados por velocidad:

1. **Rollback Vercel (segundos)** — `vercel rollback` al deployment previo. Restaura `webhook.js` viejo + `reactivation-check.js` vivo.
2. **Rollback git (minutos)** — `git revert <commit> && vercel --prod`.
3. **Restore manual desde backup (último recurso)** — `cp api/_backup/* api/ && cp api/_backup/vercel.json . && vercel --prod`.

**Si el cron falla pero webhook está OK:** temporalmente eliminar `crons` de `vercel.json` y redeploy — el webhook sigue funcionando, el cron se pausa hasta fix. No requiere rollback total.

## 8. Riesgos identificados

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Vercel ignora `crons` declarativo si ya hay cron en dashboard | Media | Cron duplicado (10 envíos en vez de 5) | Eliminar manualmente el cron del dashboard ANTES del deploy. Verificar Settings → Cron Jobs. |
| `MAX_SENDS_PER_RUN=5` se duplica con doble invocación | Media | Mass-messaging | Mismo punto anterior + verificar logs primer ciclo post-deploy |
| Webhook POST trae query param accidental `?mode=cron` desde Wapify | Muy baja | Wapify dispara cron logic | Validar `req.method==='GET'` en branch cron como segunda señal |
| Cold start más lento (archivo ~25KB → ~40KB) | Baja | +50-100ms en p99 webhook | Aceptable; Wapify timeout es 30s |
| `extractIds`/`callClaude` rotos al refactorizar imports | Baja | Webhook completo caído | Smoke test paso 6 lo detecta antes de prod |
| Cron declarativo requiere Vercel Pro (Hobby permite 2 crons básicos) | Media | Cron no corre | Validar plan actual con `vercel project ls`; si Hobby, mantener cron via dashboard apuntando a `/api/webhook?mode=cron` |
| Logs cron y webhook se mezclan | Alta | Operacional | Prefijar logs con `[REACTIVATION]` y `[WEBHOOK]` (ya lo hacen) |
| `REACTIVATION_DRY_RUN` no se respeta tras fusión | Baja | Envíos reales | Test #3 valida `dry_run==true` explícitamente |

## 9. Tiempo estimado y prerequisitos

**Tiempo total:** 90-120 min de trabajo activo + 1 ciclo cron (5 min) de observación.

Desglose:
- Edición código + vercel.json: 30 min
- Deploy preview + smoke tests: 20 min
- Deploy prod + observación: 30 min
- Eliminación archivo + deploy final: 15 min

**Prerequisitos (deben estar verdes):**
1. ✅ Sprint 1 Fase 1 completado y estable >24h (text-utils.js + state.js en producción sin errores)
2. ✅ `WAPIFY_TOKEN`, `ANTHROPIC_API_KEY`, `REACTIVATION_DRY_RUN=true` presentes en `vercel env ls`
3. ✅ Backup verificado: `ls api/_backup/reactivation-check.js.bak-*` retorna archivo
4. ✅ Git working tree limpio en branch dedicado (`feat/merge-reactivation-into-webhook`)
5. ✅ Acceso al dashboard Vercel para auditar/eliminar cron jobs existentes
6. ✅ Plan Vercel verificado (Hobby vs Pro) para decidir si `crons` declarativo aplica
7. ✅ Ventana de baja actividad confirmada (idealmente 2-6am CST — Wapify reporta <5 POST/hr)
8. ✅ `vercel logs --since 1h` muestra ejecuciones cron actuales sanas (baseline)

## Resultado esperado

- `/api/` pasa de 12 → 11 archivos
- 1 slot libre para `api/conversation-intel.js` (Fase 3A)
- Cero cambios en payload Wapify ni en comportamiento del cron
- Código deduplicado (helpers Wapify unificados)

## Archivos críticos para implementación

- `api/webhook.js`
- `api/reactivation-check.js`
- `vercel.json`
- `scripts/migrate-fase1-sprint1.sh` (referenciar como precedente)
- `api/_backup/` (a crear durante migración)
