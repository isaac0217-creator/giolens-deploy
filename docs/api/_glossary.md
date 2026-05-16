---
title: GioLens API — Glosario de términos del dominio
file_path: /docs/api/_glossary.md
last_updated: 2026-05-15
---

# Glosario GioLens

Referencia rápida de términos, IDs y convenciones que aparecen repetidamente en los 12 endpoints y en sus payloads.

---

## Pipelines (5 pipelines productivos)

| ID Wapify | Nombre comercial | Producto | CPR (May 2026) | Motor handler |
|-----------|------------------|----------|----------------|---------------|
| `216977` | Justin · Holbrook · Litebeam | Armazones ópticos premium ($2,200 – $4,950 MXN) | $8.64 | `motorJustinHolbrook` |
| `755062` | GioSports · Deportivo | Lentes deportivos / RecSpecs ($1,950 – $4,450 MXN) | $10.29 | `motorGioSports` |
| `252999` | SPY Z87 · Seguridad Industrial | Lentes ANSI Z87.1 ($2,999 – $9,950 MXN) | $15.20 | `motorSpyZ87` |
| `94103` | Dama · Luxury | Armazones diseñador mujer (Michael Kors, Versace, $3,500 – $6,500 MXN) | $23.53 | `motorDamaLuxury` |
| `273944` | GioVision · Entintados | Entintados/fotocromáticos ($950 promo gancho, $2,800 – $5,200 MXN) | $27.78 | `motorGioVision` |

**Pipeline "claudeNOVA"** (ID `278215`) es el nombre lógico bajo el cual se registra el webhook en Wapify; despacha al motor correspondiente según `pipeline_id` del payload.

---

## CPR — Costo por Resultado

Métrica Meta Ads que representa el costo en MXN de generar un lead (conversación iniciada de WhatsApp) en cada pipeline. Se calcula como `spend / mensajes` por campaña. Es el insumo principal para Motor #4 (Arbitraje) y para priorizar atención humana en Motor #5 (Copiloto).

---

## INT1 / INT2 / INT3 — Las 3 interacciones del journey

GioLens modela cada conversación como un máximo de 3 interacciones distintas:

- **INT1**: Primer contacto del lead (entró por anuncio). Etapas típicas: `NUEVO`, `BOT ACTIVO`, `COTIZADO`, `CTA VISITA`, `RUTA COMERCIAL`, `RUTA MÉDICA`, `PRECIO ENTREGADO`.
- **INT2**: Continuidad / catálogo / re-entrada. Etapas: `INT2 · CATÁLOGO`, `INT2 · RE-ENTRADA`.
- **INT3**: Retargeting / cierre. Etapas: `INT3 · PROMO ACTIVA`, `NT3 · COMPARATIVA` (typo CRM — falta la I).
- **Cierre**: `UBICACIÓN ENVIADA`, `MÉTODO DE PAGO` / `METODO PAGO`.
- **Won**: `VISITA CONFIRMADA`, `VENTA CONFIRMADA`, `CLIENTE GANADO`.
- **Lost**: `FUERA DE CATÁLOGO`, `CATCH-ALL`, `LEAD PERDIDO`, `FUERA DEL FLUJO`.

La clasificación está implementada en `classifyStage()` de [`pipeline-summary.js`](./pipeline-summary.md) y en `STAGE_POSITION` de [`microseg.js`](./microseg.md).

---

## RUTA — Rama del journey

- **RUTA COMERCIAL**: Precio, modelo, visita. Es la ruta default para casi todos los pipelines (excepto Justin/Holbrook que arrancan con cualificación visual).
- **RUTA MÉDICA**: Graduación, receta, examen de vista, progresivo. Activada si el lead menciona síntoma visual, examen o receta.

Los prompts de `auto-prompt` y `copiloto` aceptan `ruta` como parámetro para sesgar el script generado.

---

## `##ESTADO:...##` — Tag de control GPT/Wapify

Marca textual que el modelo emisor (GPT-4o de Wapify, no Claude) añade al final de su respuesta para indicar a Wapify a qué etapa mover al lead. Ejemplos:

```
##ESTADO:CTA_VISITA##
##ESTADO:COTIZADO##
```

El endpoint [`/api/clean-message`](./clean-message.md) elimina TODOS los tags `##ESTADO:...##` (incluso intermedios cuando GPT concatena dos respuestas) antes de que Wapify envíe el texto al lead. Regex usado:

```js
text.replace(/\n?##ESTADO:[^#\n]+##[ \t]*/g, '').trimEnd();
```

---

## Etapas — Nombres exactos (preservar typos)

La API de Wapify devuelve nombres de etapa con typos, mayúsculas inconsistentes y espacios accidentales. NUNCA normalizarlos al hacer `move_stage`. Ejemplos críticos:

| Nombre devuelto por Wapify | Pipeline | Observación |
|----------------------------|----------|-------------|
| `NT3 · COMPARATIVA` | 216977, 755062, 94103 | Falta la "I" de INT3 |
| `COTIZcion` | 252999 | Typo, no es "Cotización" |
| `NECESIDAD DETECTADA ` | 252999 | Tiene espacio al final |
| `metodo de pago` (minúsculas) | 252999 | sin tilde y minúsculas |
| `METODO PAGO` (sin DE, sin acento) | 216977, 755062 | |
| `MÉTODO DE PAGO` (con tilde y DE) | 94103 | |
| `CATÁLOGO RETARGETING reactivacion` | 273944 | Mezcla mayús/minús, sin acento en "reactivacion" |
| `fuera del flujo` (vs `FUERA DE CATÁLOGO`) | 252999 | Variante por pipeline |
| `·` (carácter U+00B7) | Todos | NO es asterisco ni guión — middle dot |

`pipeline-summary.classifyStage()` normaliza con `.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')` solo para clasificación, nunca para escritura.

---

## Tools del bot Claude (webhook)

El motor de cada pipeline expone 5 tools al modelo (`tool_choice: auto`):

1. **`send_message`** — Envía un texto al lead por WhatsApp (vía `POST contacts/{id}/send` de Wapify).
2. **`move_stage`** — Mueve al lead a otra etapa (DELETE + POST a `pipelines/{pid}/opportunities`).
3. **`send_and_move`** — Combina los dos anteriores.
4. **`escalate_human`** — Log de escalada; el caso queda para revisión manual (sin acción automática).
5. **`no_action`** — Explícitamente no hacer nada (lead acaba de ser contactado, conversación cerrada, etc.).

Definición completa en [`webhook.md`](./webhook.md#tools-de-claude).

---

## Segmentación de leads (Motor #3 / microseg)

| Segmento | Criterio (combinación) |
|----------|------------------------|
| 🔥 Caliente | `actividad=activo` (silencio < 48h) **+** `posicion=cierre` (UBICACIÓN, METODO PAGO, VISITA, VENTA) |
| ⚡ Activo | `actividad=activo` **+** `recencia=reciente` (entró esta semana) |
| 🌡️ Tibio | `actividad=estancado` (silencio > 48h) **+** `posicion=mitad` (INT2) |
| ❄️ Frío | Resto (sin actividad, antiguo, o etapa inicial sin progreso) |

---

## Decisiones del Motor #4 / arbitraje

Score 0-100 = combinación de eficiencia (clicks/peso, peso 70%) y CTR (peso 30%), normalizado a la mejor campaña del periodo.

- **Score 70-100** → 🟢 `escalar`
- **Score 40-69** → 🟡 `mantener`
- **Score 0-39** → 🔴 `reducir` (o pausar)

---

## Campañas Meta Ads conocidas (mapping)

| `campaign_id` | Pipeline | Tipo |
|---------------|----------|------|
| `120243518605340263` | Justin · Holbrook | prospección |
| `120243519211130263` | Justin · Holbrook | retargeting |
| `120244599911580263` | Dama · Luxury | prospección |
| `120244603173850263` | GioVision | prospección |
| `120244682313890263` | GioSports + SPY | prospección |

Definido en `CAMPAIGN_PIPELINE` de `arbitraje.js`.

---

## Action types Meta — Conversaciones de WhatsApp

El motor `meta.js` revisa varios `action_type` para extraer el dato de "mensajes":

```
onsite_conversion.messaging_conversation_started_7d   ← preferido
messaging_conversation_started_7d
onsite_conversion.messaging_conversation_started_1d
messaging_conversation_started
```

Devuelve el primer valor > 0 encontrado en ese orden.

---

## Time ranges estándar

Casi todos los endpoints Meta usan **ventanas de 7 días terminadas ayer**:

- `curr`: desde hace 7 días hasta ayer
- `prev`: los 7 días previos a `curr` (semana anterior, para deltas)

Implementado en `buildTimeRanges()` (duplicado en `meta.js`, `arbitraje.js`, `predictor.js`).

---

## Tiendas físicas

- **Plaza MAC, Zona Río** · Blvd. Rodolfo Sánchez Taboada #16004, Local 10
- **Horario**: Lunes a Sábado 10am – 5pm (última cita 4:30pm)
- **Tel/WA**: el contacto entra por el mismo WhatsApp del lead

---

## Estructura típica de payload Wapify webhook

```json
{
  "event": "opportunity.stage_changed",
  "user": { "id": "<contact_id>", "first_name": "..." },
  "data": {
    "id": "<card_id / opportunity_id>",
    "contact": { "first_name": "..." },
    "contact_id": "<contact_id>",
    "pipeline": { "id": "216977" },
    "stage":    { "id": 5, "name": "INT2 · CATÁLOGO" },
    "message":  "texto del lead"
  }
}
```

`extractIds()` en `webhook.js` cubre múltiples variantes del schema (Wapify ha cambiado al menos 3 veces). Soporta `payload.user`, `payload.data`, `payload.payload`, `payload.card`, `payload.opportunity`.
