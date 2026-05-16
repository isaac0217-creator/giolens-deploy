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

# Arrancar migración (script de 10 pasos)
bash scripts/migrate-fase1-sprint1.sh
```

Duración estimada migración: **~7 horas** (env vars Vercel + schema Supabase + migración localStorage→Postgres + auto-refresh Meta + Sentry).

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
