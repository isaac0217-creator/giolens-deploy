# /evals — Framework de evals GioLens

Sprint 6 · Fase 2 estratégica. Implementa el framework
`input → expected → actual → diff` para los 5 motores Claude y el agente
Analista (Fase 3). Incluye el loop QA↔Dev §16 del HTML maestro GIOCORE v10.

## Cómo correr

```bash
# Todos los goldens (modo mock determinista — no usa API)
node evals/run-all.js

# Un solo motor
node evals/run-all.js --motor=216977

# Modo LIVE — llama a Anthropic con prompts reales (requiere ANTHROPIC_API_KEY)
LIVE=1 node evals/run-all.js
```

Exit code `0` si todo pasa, `1` si algo falla, `2` si error fatal.

## Estructura

```
evals/
  golden/
    motor-justin-holbrook.json     # 5 casos
    motor-giosports.json           # 5 casos
    motor-spy-z87.json             # 5 casos
    motor-dama-luxury.json         # 5 casos
    motor-giovision.json           # 5 casos
    agente-analista.json           # 5 casos (Fase 3)
  runners/
    motor-runner.js                # adapter para los 5 motores Haiku 4.5
    agente-runner.js               # adapter para agente Analista (stub)
  harness.js                       # runEval + assertOutput + prettyPrint
  loop-qa-dev.js                   # loop QA↔Dev iterativo
  run-all.js                       # entry point
  package-stubs.md                 # deps futuras (Vitest, SDK)
  README.md                        # este archivo
```

## Cómo añadir un eval nuevo

1. Abre el JSON de golden correspondiente en `evals/golden/`.
2. Añade un caso al array `cases`:
   ```json
   {
     "id": "jh-06-mi-nuevo-caso",
     "description": "Descripción humana de qué evalúa.",
     "input": {
       "event": "incoming_message",
       "stage": "COTIZADO",
       "last_message": "Texto del lead",
       "contact_name": "Nombre"
     },
     "expected": {
       "tool_should_be_called": ["send_message"],
       "message_should_mention": ["palabra clave"]
     }
   }
   ```
3. Vuelve a correr `node evals/run-all.js`.

### Estrategias de `expected` disponibles

| Clave                          | Tipo          | Qué valida                                                                |
| ------------------------------ | ------------- | -------------------------------------------------------------------------- |
| `tool_should_be_called`        | string \| []  | El motor llamó a un tool cuyo nombre está en la lista permitida.           |
| `stage_should_move_to`         | string \| []  | El tool input incluye `stage_name` que matchea alguno permitido.           |
| `message_should_mention`       | string[]      | El texto del mensaje contiene ALGUNO (case + acento insensitive).          |
| `message_should_NOT_mention`   | string[]      | El texto NO contiene ninguno de los términos prohibidos.                   |
| `insights_count_at_least`      | number        | (Agentes) `result.insights` tiene al menos N elementos.                    |
| `insights_should_mention`      | string[]      | (Agentes) Algún insight menciona alguno de los términos.                   |

Se pueden combinar varias claves en un mismo `expected`. Todas deben pasar.

## Cómo interpretar resultados

```
━━━ justin-holbrook — 4/5 pass ━━━
  [ok]   jh-01-precio-rango — Lead pregunta precio en NUEVO...
  [ok]   jh-02-sintoma-visual — Lead menciona síntoma visual...
  [fail] jh-03-confirma-visita — Lead confirma que pasará a la tienda...
         razón: stage=VISITA no está en permitidos [VISITA CONFIRMADA]
         actual.tool: {"name":"send_and_move","input":{"text":"...","stage_name":"VISITA"}}
  ...
```

- `[ok]` / `[fail]` por caso, con razón concreta del fallo.
- Al final un summary `TOTAL: N/M pass`.

## Loop QA ↔ Dev

```js
import { runQaDevLoop } from './loop-qa-dev.js';
import { loadGolden } from './harness.js';

const golden = await loadGolden('./golden/motor-justin-holbrook.json');
const result = await runQaDevLoop({
  specChange: { motor: '216977', description: 'Mover a UBICACIÓN cuando pidan dirección' },
  golden,
  maxIterations: 3,
});

if (result.success) console.log('✓ pasó en', result.iterations, 'iter');
else if (result.escalate) console.log('escalar — últimos findings:', result.lastFindings);
```

El loop usa stubs (`mockDevAgent`, `mockQaRunner`). Cuando los agentes reales
existan en `/agents/dev/` y `/agents/qa/` (Fase 3 sem 7-10), se reemplazan los
stubs sin tocar el flujo.

## Modo LIVE (Anthropic real)

`LIVE=1` activa la ruta `callLive()` en `motor-runner.js`. Hoy es un stub que
cae al mock con warning — para activarlo realmente, exportar los `PROMPT_M*`
desde `/api/webhook.js` (futuro refactor) o copiar los prompts al runner.

## Restricciones de Sprint 6

- NO se modifica `/api/webhook.js` ni `/public/`.
- Los runners duplican el schema de tools y los prompts cuando hace falta.
- Las dependencias futuras (Vitest, SDK) están listadas en
  `package-stubs.md`, NO añadidas a `package.json` todavía.
