# Checklist 01 · Generar System User Token Meta

> **Tiempo estimado:** ~10 minutos
> **Quién:** Isaac (no delegable — requiere acceso de admin a Meta Business)
> **Output:** 1 token que **no expira** + queda anotado en `sprint1/credentials.local.md`

## ¿Por qué necesito esto?

El token actual de Meta (`META_TOKEN`) **expira el 2026-07-01** (quedan 46 días). Si expira sin reemplazo, todos los endpoints `/api/meta.js`, `/api/predictor.js`, `/api/microseg.js`, `/api/arbitraje.js` dejan de devolver datos y el dashboard se queda ciego de Meta Ads.

Un **System User Token** (categoría: "Token de usuario del sistema") es diferente: lo emite un usuario "del sistema" (no humano), nunca expira mientras el usuario del sistema exista, y puede tener permisos de admin sobre múltiples ad accounts.

## Prerequisitos

- [ ] Acceso admin a https://business.facebook.com de la cuenta de Óptica TJ / GioLens
- [ ] Saber el ID del Business Manager (lo dice arriba a la izquierda al entrar)
- [ ] Saber qué App ID usa GioLens hoy (revisa `META_APP_ID` en Vercel env vars o pregúntale a Code)

## Pasos

### 1. Crear el System User

1. Entra a https://business.facebook.com
2. Si tienes varios Business Managers en tu cuenta, selecciona el de **Óptica TJ / GioLens**
3. Esquina superior izquierda → ícono ⚙️ **Configuración del negocio** (Business Settings)
4. Menú izquierdo → **Usuarios** → **Usuarios del sistema**
5. Botón azul **Añadir** (Add)
   - **Nombre:** `giolens-system-user`
   - **Rol:** **Admin** (no "Empleado" — necesitas admin para auto-refresh)
6. Click **Crear usuario del sistema**

### 2. Asignar activos (Apps + Ad Accounts + Pages + WhatsApp)

Mismo usuario del sistema → botón **Añadir activos** (Add Assets) — vas a añadir 4 categorías:

- **Apps**
  - Buscar la app de GioLens (la que aparece en `META_APP_ID`)
  - Permisos: marcar **"Gestionar app"** (Manage app)
- **Cuentas publicitarias** (Ad Accounts)
  - Seleccionar todas las ad accounts activas de Óptica TJ
  - Permisos: marcar **"Gestionar campañas"** (Manage campaigns) + **"Ver rendimiento"** (View performance)
- **Páginas** (Pages)
  - Página de Facebook de Óptica TJ + cualquier otra activa
  - Permisos: **"Crear contenido"** + **"Gestionar páginas"**
- **Cuentas de WhatsApp Business**
  - Si hay alguna conectada al webhook Wapify, agregarla
  - Permisos: **"Gestionar cuenta de WhatsApp"**

### 3. Generar el token

1. Mismo usuario del sistema → tab **Tokens de acceso** (Access Tokens)
2. Botón **Generar nuevo token**
3. Seleccionar la app de GioLens
4. **Permisos** a marcar (todos):
   - `ads_management`
   - `ads_read`
   - `business_management`
   - `pages_read_engagement`
   - `pages_show_list`
   - `pages_manage_metadata`
   - `leads_retrieval`
   - `instagram_basic`
   - `instagram_manage_messages`
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. **Caducidad:** seleccionar **"Sin caducidad"** (Never expires) — ⚠️ crítico
6. Click **Generar token**
7. **Copia el token completo a un lugar seguro INMEDIATAMENTE** — la UI solo te lo muestra una vez. Si lo pierdes, hay que generar otro.

### 4. Verificar que el token funciona

Abre terminal y corre (reemplazando `<TU_TOKEN_NUEVO>`):

```bash
curl -s "https://graph.facebook.com/v19.0/me?access_token=<TU_TOKEN_NUEVO>" | python3 -m json.tool
```

**Resultado esperado:**
```json
{
  "name": "giolens-system-user",
  "id": "<numero_largo>"
}
```

Si devuelve error tipo `(#190) Invalid OAuth access token` → el token no se generó bien, vuelve al paso 3.

Verifica también que puede ver las ad accounts:
```bash
curl -s "https://graph.facebook.com/v19.0/me/adaccounts?access_token=<TU_TOKEN_NUEVO>" | python3 -m json.tool
```

Debe listar las ad accounts que asignaste en el paso 2.

### 5. Guardar en credentials.local.md

Abre [credentials.local.md.template](credentials.local.md.template), cópialo a `credentials.local.md` (sin `.template`) y pega el token nuevo en la línea de `META_TOKEN=`.

⛔ **NUNCA commitees `credentials.local.md` a git.** Está en `.gitignore`, pero verifica con `git status` antes de cualquier commit.

## Si algo falla

- **"No tengo opción de Sin caducidad"** → tu rol no es Admin del Business Manager. Pídeselo al dueño de la cuenta.
- **"No veo la app de GioLens al asignar activos"** → la app no está en este Business Manager. Hay que transferirla primero (Business Settings → Cuentas → Apps → Solicitar acceso).
- **"El token funciona en Graph Explorer pero falla desde Vercel"** → puede ser falta de algún permiso. Vuelve al paso 3 y regenera marcando todos los de la lista.

## Siguiente paso

Cuando termines este checklist y tengas el token guardado en `credentials.local.md`, sigue con [02_isaac_supabase_setup.md](02_isaac_supabase_setup.md).
