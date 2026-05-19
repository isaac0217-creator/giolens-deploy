---
title: /api/clean-message — Utility para Wapify
file_path: /docs/api/clean-message.md
source: /api/clean-message.js
last_updated: 2026-05-15
status: deprecated
---

> ⚠️ **DEPRECATED — fusionado en `/api/text-utils?op=clean`** (Sprint 1, 16 may 2026).
> El handler vive ahora en [`text-utils.js`](../../api/text-utils.js) tras el router `?op=clean`.
> Esta documentación se preserva **solo por historial git**. Para uso operativo ver [text-utils.md](./text-utils.md).
> Migración del caller (Wapify HTTP Action): cambiar URL a `POST /api/text-utils?op=clean` (body `{ text }` idéntico).

# `/api/clean-message`

Utility de string para Wapify. Recibe el output completo de GPT (campo `Respuesta_ChatGPT`) y devuelve el texto sin los tags de control `##ESTADO:...##`. Se invoca desde una HTTP Action de Wapify justo antes de "Enviar mensaje #1".

## URL

```
GET     https://giolens-dashboard.vercel.app/api/clean-message?text={text}
POST    https://giolens-dashboard.vercel.app/api/clean-message
```

## Métodos

### `GET` — Test/debug

Acepta `text` por query string. Útil para verificar el comportamiento desde el navegador.

```
GET /api/clean-message?text=Hola%20!%20##ESTADO:CTA_VISITA##
→ { "clean": "Hola !" }
```

### `POST` — Llamado por Wapify

**Request body:**
```json
{ "text": "Hola, te paso el catálogo 👋\n##ESTADO:INT2_CATALOGO##" }
```

**Response 200:**
```json
{ "clean": "Hola, te paso el catálogo 👋" }
```

**Response 400:**
```json
{ "error": "Missing text param" }
```

## Propósito

GPT (en Wapify) responde con texto + un tag `##ESTADO:XYZ##` al final que le dice a Wapify a qué etapa mover el lead. Sin este endpoint, el lead recibiría ese tag literal en su WhatsApp.

Cuando GPT genera dos respuestas concatenadas (cosa frecuente cuando el lead manda varios mensajes), aparecen tags INTERMEDIOS también. El regex elimina TODOS los tags, no solo el del final.

## Regex usado

```js
text
  .replace(/\n?##ESTADO:[^#\n]+##[ \t]*/g, '')
  .trimEnd();
```

- `\n?` — opcionalmente come un newline previo
- `##ESTADO:` — literal
- `[^#\n]+` — contenido del tag (cualquier cosa menos `#` o newline)
- `##` — literal de cierre
- `[ \t]*` — come espacios/tabs después del tag
- `.trimEnd()` — quita trailing whitespace residual

## Dependencies

- ❌ Ninguna externa.

## Side effects

- ❌ Ninguno. Pure function.

## Caller

- **Wapify Workflow** — HTTP Action POST configurada antes del nodo "Enviar mensaje #1". Guarda la respuesta en la variable `mensaje_limpio` que luego se usa en el bloque de envío.

## Env vars

- ❌ Ninguna.

## Notas operativas

- **Timeout**: 10 s default. Ejecución <10 ms.
- **Endpoint público sin auth** — no maneja secretos.
- **Caso degenerado**: si el texto SOLO es el tag (`##ESTADO:X##`), devuelve `clean: ''` — el llamador (Wapify) debe verificar antes de enviar.
- **No valida que el tag sea conocido** — elimina cualquier `##ESTADO:loquesea##`. Esto es intencional: la lista de estados cambia con frecuencia y esta utility no debe acoplarse a ella.
- **Por qué NO está en el flujo Claude**: porque Claude (via webhook.js) genera respuestas estructuradas vía tool use, no concatena tags. Esta utility es exclusivamente para el flujo legacy GPT-Wapify.
