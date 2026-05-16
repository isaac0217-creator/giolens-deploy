# scripts/ — Automatización GioLens

## migrate-fase1-sprint1.sh

Setup completo de Fase 1 Sprint 1: Supabase + fusión APIs + deploy + smoke tests.

### Pre-requisitos

Variables de entorno exportadas antes de correr:

```bash
export SUPABASE_URL="https://xxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."     # del dashboard Supabase
export ANTHROPIC_API_KEY="sk-ant-..."         # ya seteado normalmente
# Opcional (default: https://giolens.vercel.app):
# export PROD_URL="https://giolens.vercel.app"
```

Herramientas: `vercel`, `npm`, `node` >=18, `curl`, `bash` 3.2+.

### Ejecución

```bash
cd /Users/chunkuni/giolens_deploy
bash scripts/migrate-fase1-sprint1.sh
```

El script se detiene en cada paso interactivo y espera ENTER. Aborta con Ctrl+C en cualquier momento.

### Pasos

| # | Paso | Tipo |
|---|---|---|
| 0 | Pre-flight (ENV vars + tools) | Automático |
| 1 | Aplicar SQL Supabase | Manual (copy/paste al SQL Editor) |
| 2 | `vercel env add` x2 | Interactivo |
| 3 | `npm install @supabase/supabase-js` | Automático |
| 4 | Backup `auto-prompt.js` + `clean-message.js` a `api/_backup/` | Automático |
| 5 | Crear `api/text-utils.js` | Manual (código nuevo) |
| 6 | Crear `api/state.js` | Manual (código nuevo) |
| 7 | Validar `ls api/*.js | wc -l == 12` | Automático |
| 8 | `vercel --prod --yes` | Automático |
| 9 | Smoke tests `text-utils` y `state` con curl | Automático |
| 10 | `node evals/run-all.js` | Automático |

### Qué hacer si falla

| Paso falla | Diagnóstico | Acción |
|---|---|---|
| 0 | Falta ENV var | Exporta la var y re-corre. Idempotente desde el paso 0. |
| 0 | `vercel` no encontrado | `npm i -g vercel`, luego `vercel login`. |
| 1 | Query verificación devuelve != esperado | Revisa output del SQL Editor. Comúnmente: `pg_cron` no habilitado en proyecto Free — actívalo en Database > Extensions. Re-corre el SQL (idempotente). |
| 2 | `vercel env add` dice "already exists" | OK, continúa. El script lo trata como warning. |
| 3 | `npm install` falla por red | Re-intenta. Si persiste: `npm cache clean --force && npm install @supabase/supabase-js`. |
| 4 | Backup ya existe | OK, el script usa timestamp único por corrida. |
| 5/6 | Archivo no creado al confirmar | El script asume buena fe; si confirmas sin crear, fallará en paso 8/9. Re-corre desde paso 5. |
| 7 | Slot Vercel != 12 | Lista los archivos en `/api/`. Posibles causas: olvidaste borrar `auto-prompt.js`/`clean-message.js` (debe quedar `text-utils.js` y `state.js` en su lugar, neto 0). Borra los originales antes de re-correr. |
| 8 | Deploy falla | Lee output Vercel. Errores típicos: build error en `text-utils.js`/`state.js` (sintaxis), o env var faltante. Corrige el archivo y re-corre desde paso 8 (no rompe nada antes). |
| 9 | smoke test 500 | `vercel logs --prod` para ver stacktrace. Suele ser `SUPABASE_URL` mal escrito o RLS bloqueando con anon key. |
| 9 | smoke test 404 | El endpoint no se desplegó. Verifica que el archivo está en `/api/` y que el deploy del paso 8 fue exitoso. |
| 10 | Evals fallan | Snapshot regresión. Compara contra commit previo: `git diff HEAD~1 -- agents/ evals/`. Si el cambio fue intencional, actualiza el golden dataset. |

### Rollback

Si necesitas revertir Fase 1 Sprint 1 completa:

```bash
# 1. Restaurar APIs originales desde backup (toma el timestamp más reciente)
LATEST=$(ls -t api/_backup/auto-prompt-*.js | head -1)
cp "$LATEST" api/auto-prompt.js
LATEST=$(ls -t api/_backup/clean-message-*.js | head -1)
cp "$LATEST" api/clean-message.js

# 2. Eliminar los archivos nuevos
rm -f api/text-utils.js api/state.js

# 3. Verificar slot Vercel = 12
ls api/*.js | wc -l    # debe imprimir 12

# 4. Re-deploy
vercel --prod --yes

# 5. (Opcional) Limpiar tablas Supabase
#    Desde SQL Editor:
#      drop table if exists public.gl_timeseries cascade;
#      drop table if exists public.gl_kv cascade;
#      select cron.unschedule('gl_timeseries_purge_old');
#      drop function if exists public.kv_upsert(text, jsonb);
#      drop function if exists public.kv_upsert(text, text, jsonb);
#      drop function if exists public.gl_timeseries_purge_old();

# 6. (Opcional) Quitar ENV vars de Vercel
vercel env rm SUPABASE_URL production
vercel env rm SUPABASE_SERVICE_ROLE_KEY production

# 7. (Opcional) Desinstalar dep
npm uninstall @supabase/supabase-js
```

### Notas

- El script es **mayormente idempotente**: re-correrlo después de un fallo en pasos automáticos no rompe nada. Los pasos manuales (1, 5, 6) requieren cuidado.
- `set -euo pipefail` corta al primer error. No silencies errores sin entender la causa.
- Los smoke tests asumen `PROD_URL=https://giolens.vercel.app`. Si el dominio cambió, exporta `PROD_URL` antes.
- El cron `pg_cron` requiere que la extensión esté habilitada en el proyecto Supabase (Database > Extensions > pg_cron). En Free tier se permite.
