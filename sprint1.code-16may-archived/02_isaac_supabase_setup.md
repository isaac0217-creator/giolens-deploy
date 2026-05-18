# Checklist 02 · Crear proyecto Supabase + obtener 3 keys

> **Tiempo estimado:** ~15 minutos (incluyendo provisioning)
> **Quién:** Isaac
> **Output:** 3 keys (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) anotadas en `sprint1/credentials.local.md`

## ¿Por qué necesito esto?

Hoy el dashboard guarda contexto en `localStorage` del navegador. Si vacías localStorage, se pierden:
- Panel Contexto IA (key `giolens_ai_context_v1`)
- Cualquier cache del dashboard

También necesitamos una BD real para Fase 2 estratégica (agentes con persistencia, audit log, knowledge base). Supabase nos da Postgres + Auth + Realtime en un solo lugar. **Tier Free alcanza para Fase 1 + parte de Fase 2.**

## Prerequisitos

- [ ] Cuenta en https://supabase.com (puedes hacer login con GitHub si tienes)
- [ ] Un email/contraseña que sí vas a recordar para la BD

## Pasos

### 1. Crear el proyecto

1. Entra a https://app.supabase.com y haz login
2. Botón **New project** (esquina superior derecha o pantalla principal)
3. Selecciona/crea organización (puede ser "GioLens")
4. **Project name:** `giolens-prod`
5. **Database Password:** click "Generate a password" y **GUÁRDALA inmediatamente** (la vas a usar para acceso directo a Postgres y solo se muestra esta vez)
6. **Region:** `West US (North California)` — es la región más cercana a Tijuana y la usa Vercel también, así minimiza latencia
7. **Pricing plan:** **Free** (después puedes upgradear a Pro $25/mes cuando lo necesitemos)
8. Click **Create new project**

⏱ Esperar **~2 minutos** mientras Supabase provisiona la BD. Verás el dashboard cargar cuando termine.

### 2. Obtener las 3 keys

Una vez cargado el proyecto:

1. Menú izquierdo → ⚙️ **Project Settings**
2. Submenu → **API**

Vas a copiar 3 cosas:

| Campo en Supabase | Variable en credentials.local.md | Comentario |
|---|---|---|
| **Project URL** | `SUPABASE_URL` | Algo como `https://abcdefghij.supabase.co` |
| **Project API keys → `anon` `public`** | `SUPABASE_ANON_KEY` | Empieza con `eyJ...` — segura para frontend |
| **Project API keys → `service_role` `secret`** | `SUPABASE_SERVICE_ROLE_KEY` | Empieza con `eyJ...` — ⚠️ **NUNCA expongas en frontend** — solo backend/workers |

Copia cada uno y pégalo en `sprint1/credentials.local.md` (ver checklist 03).

### 3. Verificar conexión

Abre terminal y corre (reemplazando `<TU_SUPABASE_URL>` y `<TU_ANON_KEY>`):

```bash
curl -s "<TU_SUPABASE_URL>/rest/v1/" -H "apikey: <TU_ANON_KEY>" | python3 -m json.tool
```

**Resultado esperado:** JSON con `{"swagger": "2.0", "info": {...}}` — significa que el endpoint REST de PostgREST responde.

Si devuelve `{"message": "Invalid API key"}` → la key está mal copiada (ojo con espacios al inicio/final).

### 4. (NO HACER TODAVÍA) Aplicar el schema

⛔ **NO pegues todavía el contenido de `agents/_shared/supabase-schema.sql`** en el SQL Editor.

Code está corrigiendo 2 bugs + 3 mejoras en el schema (delegado por Cowork). Una vez aplicados los fixes, **Code te avisará** y entonces sí lo pegas:

1. Menú izquierdo → 🛢️ **SQL Editor**
2. **New query**
3. Pegar el contenido completo de `agents/_shared/supabase-schema.sql` (versión post-fix)
4. **Run** (esquina inferior derecha o `Cmd+Enter`)
5. Verificar **0 errors** en consola
6. Menú izquierdo → 🗂️ **Table Editor** → confirmar que existen las 10 tablas:
   - `contacts`, `events`, `metrics`, `decisions`
   - `agent_runs`, `agent_messages`, `agent_decisions`
   - `human_approvals`, `knowledge_base`, `audit_log`

### 5. Guardar las 3 keys en credentials.local.md

Pega las 3 keys en `sprint1/credentials.local.md` siguiendo [credentials.local.md.template](credentials.local.md.template).

⛔ **NUNCA commitees `credentials.local.md` a git.**

## Si algo falla

- **"El proyecto se queda en 'Setting up'" más de 5 min** → recarga la página. Si persiste, abre ticket en Supabase support.
- **"No veo Project API keys en Settings → API"** → asegúrate de estar en el proyecto correcto (esquina superior izquierda, dropdown de proyecto).
- **"Me da error de quota al crear"** → ya tienes 2 proyectos Free activos (límite del tier). Borra uno viejo o upgrade a Pro.
- **"La región no aparece como opción"** → puede estar saturada. Selecciona `West US (Oregon)` como alternativa cercana.

## Siguiente paso

Cuando tengas las 3 keys guardadas en `credentials.local.md` y el token Meta del checklist 01, **avisa a Claude Code** para arrancar la migración Fase 1 Sprint 1 (~7 horas de ejecución).
