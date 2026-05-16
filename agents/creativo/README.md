# Agente Creativo — GioLens (Fase 3 · GIOCORE)

Tercer agente de la Fase 3. **Riesgo medio**: genera drafts (scripts WhatsApp, ángulos de anuncio, plantillas de reactivación). **NUNCA publica** sin aprobación humana.

## Qué hace

3 flujos creativos bajo demanda, todos producen DRAFTS:

| Flujo | Función | Input | Output |
|---|---|---|---|
| (a) | `generateScriptVariants` | `pipelineId`, `stage`, `insightContext?` | 3 variantes con ángulo distinto |
| (b) | `generateAdAngles`       | `pipelineId`, `period?`, `performanceContext?` | 3 ángulos con headline/body/CTA |
| (c) | `generateReactivationTemplate` | `pipelineId`, `stageIn`, `daysInactive` | 1 plantilla + 2 alternativas |

Cada draft se publica al bus con `status='draft'` + `requires_approval=true` y se solicita aprobación vía `requestApproval` (stub auto-aprueba en Fase 1).

## Política de drafts

- Toda variante nueva → status `draft`.
- Solo las plantillas que viven en `/templates/` (status `approved`) pueden ser auto-rotadas por otros agentes (Optimización, Reactivación).
- El Creativo nunca publica anuncios en Meta, nunca envía mensajes a leads, nunca mueve etapas.
- Restricción dura en el `SYSTEM_PROMPT`: *"No tienes capacidad de publicar — solo proponer"*.

## Cómo aprobar un draft y promoverlo a `/templates`

1. Observar `draft.{script,ad,reactivation}` en el bus (o en el dashboard widget Fase 2).
2. Validar contenido con el equipo (Isaac + ventas).
3. Crear nuevo archivo JSON en `agents/creativo/templates/` con la forma:

   ```json
   {
     "id": "reactivacion-<pipeline>-v<n>",
     "pipeline_id": "<pipeline_id>",
     "pipeline_name": "<nombre>",
     "task": "reactivation|script|ad",
     "status": "approved",
     "approved_by": "isaac",
     "approved_at": "<ISO 8601>",
     "version": <n>,
     "content": "<texto con [PARAM]>",
     "params": ["NOMBRE", "..."],
     "notes": "<por qué se aprobó>",
     "source": "<draft ref o prompt fuente>"
   }
   ```

4. Subir a `main`. Otros agentes recogerán la versión nueva en el próximo run.

## Archivos

| Archivo | Rol |
|---|---|
| `prompt.js` | `SYSTEM_PROMPT` del Creativo (identidad, formato JSON, restricción dura) |
| `tools.js` | Tools Anthropic (`read_top_ads`, `read_recent_conversations`) + handlers `saveDraft*` |
| `graph.js` | Orquestación de los 3 flujos + helper `pickInsight` |
| `index.js` | `executeCreativoOnDemand({ task, params })` — handler exportable |
| `templates/*.json` | 5 plantillas de reactivación pre-aprobadas (una por pipeline) |
| `__tests__/creativo.test.js` | Tests Vitest con mocks |

## Cómo invocar (local)

```bash
# Script variants para Holbrook etapa COTIZADO
node -e "import('./index.js').then(m=>m.default({ task:'script', params:{ pipelineId:'216977', stage:'COTIZADO' } }))"

# Ad angles para SPY Z87 últimos 7 días
node -e "import('./index.js').then(m=>m.default({ task:'ad', params:{ pipelineId:'252999', period:'last_7d' } }))"

# Reactivation para Dama, etapa COTIZADO, 7 días estancado
node -e "import('./index.js').then(m=>m.default({ task:'reactivation', params:{ pipelineId:'94103', stageIn:'COTIZADO', daysInactive:7 } }))"
```

## Dependencias / stubs requeridos

Este agente NO crea código en `/agents/_shared/`. Asume estos exports:

- `_shared/anthropic.js` → `callClaude({ model, system, tools, messages, max_tokens })`
- `_shared/bus.js` → `publish({ from_agent, to_agent, type, payload, ... })`
- `_shared/cost-tracker.js` → `track(agent, usage, model)`
- `_shared/approval.js` → `requestApproval({ decision_id, agent, action, rationale, evidence })`

## Modelo

`claude-sonnet-4-5` (§15 del HTML maestro v10). Prompts especializados por producto vía contexto en el `user message`; el `SYSTEM_PROMPT` es general y contiene los insights clave de los 5 pipelines.

## Pendientes

- `// TODO Fase 2`: `read_recent_conversations` es STUB — conectar a Supabase `conversations`.
- `// TODO Fase 2`: envolver `executeCreativoOnDemand` en `inngest.createFunction`.
- `// TODO Fase 2`: migrar `graph.js` a LangGraph `StateGraph`.
- `// TODO Fase 2`: reemplazar `requestApproval` stub por dashboard widget que bloquee hasta input humano.
- `// TODO`: persistir runs/drafts en Supabase (`agent_runs`, `agent_drafts`).
