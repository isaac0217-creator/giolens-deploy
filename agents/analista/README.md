# Agente Analista — GioLens (Fase 3 · GIOCORE)

Primer agente de la Fase 3. Solo lectura, sin riesgo: no ejecuta acciones, no gasta presupuesto, no muta estado.

## Qué hace

Analiza diariamente los 5 pipelines activos de GioLens:

- `216977` Justin · Holbrook · Litebeam
- `755062` GioSports · Deportivo
- `252999` SPY · Seguridad Z87
- `94103` Dama · Luxury
- `273944` GioVision · Entintados

Lee KPIs de Meta Ads (`read_kpis`) y estado del pipeline en CRM Wapify (`read_pipeline`), los pasa a Claude Sonnet 4 con el `SYSTEM_PROMPT` de `prompt.js`, y emite un JSON con `insights[]`. Los insights con severidad `medium`, `high` o `critical` se publican al bus como `agent_message` para que otros agentes (o humanos) actúen.

## Archivos

| Archivo | Rol |
|---|---|
| `prompt.js` | `SYSTEM_PROMPT` del Analista (identidad, formato JSON, restricción dura) |
| `tools.js` | Declaración Anthropic Tool Use de `read_kpis` y `read_pipeline` |
| `graph.js` | Orquestación `runAnalista({ pipelineIds, period })` |
| `index.js` | `executeAnalistaDailyRun()` — trigger sobre los 5 pipelines |
| `__tests__/analista.test.js` | Tests Vitest con mocks |

## Cómo invocar (local)

```bash
node -e "import('./index.js').then(m=>m.default())"
```

Por período distinto:

```bash
node -e "import('./index.js').then(m=>m.default({ period: 'last_7d' }))"
```

## Dependencias / stubs requeridos

Este agente NO crea código en `/agents/_shared/`. Asume que existen estos exports (otro agente los construye en paralelo):

- `_shared/anthropic.js` → `callClaude({ model, system, tools, messages, max_tokens })`
- `_shared/bus.js` → `publish({ type, from, severity, payload, ts })`
- `_shared/cost-tracker.js` → `trackCost({ agent, model, cost_usd, usage, ts })`
- `_shared/tools/read-kpis.js` → `default({ pipeline_id, period })`
- `_shared/tools/read-pipeline.js` → `default({ pipeline_id })`

Mientras esos archivos no existan, los tests fallarán al resolver imports — comportamiento esperado.

## Restricción inmutable

El Analista **solo recomienda**. Nunca pausa campañas, mueve leads, envía mensajes ni modifica presupuesto. Las recomendaciones se emiten en lenguaje natural en `recommendation`; la ejecución corresponde a otro agente o al humano.

## Pendientes

- `// TODO Fase 2`: envolver `executeAnalistaDailyRun` en `inngest.createFunction(...)` cuando Inngest esté instalado.
- `// TODO Fase 2`: migrar `graph.js` a LangGraph `StateGraph`.
- `// TODO`: persistir `agent_runs` en Supabase cuando exista la tabla.
- `// TODO`: leer `GIOLENS_PIPELINE_IDS` desde Supabase en vez de hardcodear.
