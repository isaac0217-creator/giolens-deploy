# Sprint 1 · Fase 1 Estratégica — Migración

> **Estado al 16 may 2026:** 🔴 BLOQUEADO esperando credenciales Isaac.
>
> Ver maestro v12 §08 (bloqueo activo) y §14 Fase 1 Sprint 1.

## Para Isaac · Orden de ejecución

| # | Acción | Duración | Archivo |
|---|--------|----------|---------|
| 1 | Generar System User Token Meta | ~10 min | [01_isaac_meta_business_suite.md](01_isaac_meta_business_suite.md) |
| 2 | Crear proyecto Supabase + 3 keys | ~15 min | [02_isaac_supabase_setup.md](02_isaac_supabase_setup.md) |
| 3 | Llenar credentials.local.md con las 6 keys | ~2 min | [credentials.local.md.template](credentials.local.md.template) |
| 4 | Avisar a Code para arrancar migración | trigger | — |

**Total tiempo Isaac:** ~30 min.

## Para Claude Code · Después de paso 4

```bash
# Verificar que las 6 keys están presentes
test -f sprint1/credentials.local.md && grep -c "^export " sprint1/credentials.local.md
# Esperado: 6

# Cargar las keys al ambiente
source sprint1/credentials.local.md

# Arrancar migración (script de 10 pasos, todos automatizados excepto Paso 1 SQL)
bash scripts/migrate-fase1-sprint1.sh
```

**Duración real estimada migración: ~45-90 min** (no las ~7h del estimado original — los Pasos 5 y 6 ahora son automáticos gracias al staging en `scripts/sprint1-staged/`, no acción manual mid-flight).

### Flow del script (con mejoras del 16 may PM)

| Paso | Tipo | Qué hace | Tiempo |
|------|------|----------|--------|
| 0 | Auto | Pre-flight (env vars + vercel + npm + curl + jq + staged files) | 5s |
| 1 | Manual | Aplicar SQL en Editor Supabase | 5 min |
| 2 | Semi-auto | Registrar 2 keys Supabase en Vercel env | 2 min |
| 3 | Auto | `npm install @supabase/supabase-js` | 30s |
| 4 | Auto | Backup `auto-prompt.js` + `clean-message.js` a `api/_backup/` | 1s |
| 5 | **Auto** | `cp scripts/sprint1-staged/text-utils.js api/` + `rm` originales + `node --check` | 2s |
| 6 | **Auto** | `cp scripts/sprint1-staged/state.js api/` + `node --check` | 2s |
| 7 | Auto | Validar slot Vercel 12/12 | 1s |
| 8 | Semi-auto | `vercel --prod --yes` | 60s |
| 9 | **Auto** | Smoke tests con jq payload validation (text-utils, state, prompt rejection) | 10s |
| 10 | Auto | Ejecutar evals | 30s |

## Reglas críticas

- ⛔ `sprint1/credentials.local.md` está en `.gitignore` — NUNCA commitear keys reales.
- ⛔ Usar `sprint1/credentials.local.md.template` como base (sin keys reales) si necesitas referencia.
- ⛔ NO ejecutar `migrate-fase1-sprint1.sh` sin las 6 keys completas. El script aborta si falta una.
- ✅ Después de aplicar el schema en Supabase Editor, verificar que las 10 tablas existen (script de check en migración).

## Resultado esperado al cerrar Sprint 1

- ✅ 6 keys en Vercel env vars (Meta System User Token + 3 Supabase + ANTHROPIC + WAPIFY)
- ✅ Schema Supabase aplicado con las 10 tablas (contacts, events, metrics, decisions, agent_runs, agent_messages, agent_decisions, human_approvals, knowledge_base, audit_log)
- ✅ localStorage del dashboard migrado a Postgres (Panel Contexto IA + giolens_ai_context_v1)
- ✅ Auto-refresh META_TOKEN configurado vía cron (antes del 2026-07-01)
- ✅ Sentry integrado con alertas en Vercel
- ✅ 100% persistencia validada (auditar: ¿qué pasa si se vacía localStorage? Dashboard sigue funcionando)
