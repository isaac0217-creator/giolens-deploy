# sim-agents.mjs — Harness de simulación GIOCORE

Smoke-test end-to-end de los 6 agentes (Analista, QA, Creativo, Optimización,
Desarrollador, Orquestador) sin tocar tokens reales ni mutar nada.

## Qué hace

Para cada agente:

1. Importa `agents/{X}/index.js` (verifica que el módulo resuelva).
2. Confirma que `default` es función.
3. Invoca el (los) entrypoint(s) con input sintético mínimo válido.
4. Reporta: `import`, `runtime`, `JSON`, `matches shape`.

NO modifica nada en `/agents`. NO commitea. Solo imprime un reporte por stdout
y sale con código `0` si todo verde, `1` si algo falla.

## Modos

### `static` (default)

Intercepta `globalThis.fetch` antes del primer import dinámico:

- Llamadas a `api.anthropic.com` → devuelven una respuesta sintética con shape
  Messages API válido y un `content[0].text` igual al `SCHEMA_SAMPLE` del task
  correspondiente. Cero tokens consumidos.
- Llamadas a `giolens-dashboard.vercel.app` o `/api/pipeline-summary` →
  devuelven `{ data:{}, pipelines:[] }` (no requiere dashboard corriendo).
- Cualquier otra URL → passthrough al fetch real (en práctica no debería
  ocurrir; si pasa, lo verás con `--verbose`).

> Por qué interceptar `fetch` y no monkey-patch de `callClaude`:
> los `graph.js` hacen `import { callClaude } from '../_shared/anthropic.js'`,
> y los named imports de ESM son bindings read-only — no se pueden reemplazar
> sin tocar el código fuente. `callAnthropic` usa `fetch` nativo, así que
> interceptar `globalThis.fetch` es el punto de extensión limpio.

### `live` (`--live`)

Pasa fetch real. Requiere `ANTHROPIC_API_KEY` en el env. Consume tokens.
Útil para validar end-to-end con Claude real una vez los bugs P0 estén
fixeados y antes de promover a producción.

## Uso

```bash
# Default: static, todos los agentes
node scripts/sim-agents.mjs

# Solo algunos agentes
node scripts/sim-agents.mjs --only=analista,qa

# Más detalle (preview de outputs + log de cada fetch interceptado)
node scripts/sim-agents.mjs --verbose

# Live (cuesta tokens, requiere ANTHROPIC_API_KEY)
node scripts/sim-agents.mjs --live
```

## Cómo interpretar el output

```
═══ Sim agents (modo: static) ═══
analista       · import ✅ · runtime ✅ · JSON ✅ · matches shape ✅
qa             · import ✅ · runtime ❌ · ... · TypeError: ...
creativo       · import ✅
  └─ script                 · runtime ✅ · JSON ✅ · shape ✅
  └─ ad                     · runtime ✅ · JSON ✅ · shape ✅
  └─ reactivation           · runtime ✅ · JSON ✅ · shape ✅
...

  17/18 runs verde.
```

- **import ❌** → `agents/X/index.js` no resuelve. Probablemente una ruta
  rota o un syntax error. El script no aborta; sigue con el resto.
- **runtime ❌** → el agente lanzó. El mensaje a la derecha es el primer
  fragmento del `err.message`. Con `--verbose` ves el stack trace.
- **JSON ❌** → el handler retornó algo que no es un objeto (raro: solo si
  retorna `null` o `undefined`).
- **shape ❌** → el output corre, es JSON, pero le falta el campo clave que
  el prompt promete (ej. `insights[]` en Analista). Suele significar que el
  parser del agente se cayó silenciosamente y devolvió un fallback con
  `error`.

## Mapeo a los 4 bugs P0 conocidos

Bugs que Code está arreglando ahora mismo. Cuando los 4 estén verdes, este
harness debería terminar con `18/18 runs verde` en static.

| Bug                                                       | Síntoma esperado                                                    |
|-----------------------------------------------------------|---------------------------------------------------------------------|
| `system:` → `systemPrompt:` (12 sitios)                   | runtime ✅ pero el wrapper recibe `systemPrompt:undefined`. Se nota más en live; en static el stub responde igual. |
| `readKpis`/`readPipeline` import default como objeto      | `analista` y `optimizacion`: errors[] poblado dentro del run, pero no aborta (el graph captura por pipeline). |
| `publish({ from })` → `publish({ from_agent, to_agent })` | `analista` falla al publicar insights medium+ con `from_agent required`. Se ve en runtime ❌. |
| `TOOL_HANDLERS` apunta al objeto en vez de `.handler`     | Solo se dispara si Anthropic devuelve un `tool_use`. En static el stub no usa tools → no aparece. Para cazar este bug, hay que correr en `--live` o un test específico. |

> Limitación conocida: el bug #4 (TOOL_HANDLERS) NO se cubre en modo static
> porque el stub fuerza `stop_reason: 'end_turn'` sin `tool_use`. Para
> validarlo hace falta `--live` o extender el stub para emitir bloques
> `tool_use` sintéticos (futuro).

## Qué NO valida

- No corre los tests de Vitest (eso es `npm test`).
- No verifica firma de `bus.publish` per se — solo que el agente no lance.
  Si el agente atrapa el error de `publish` con un try/catch silencioso, el
  bug pasa inadvertido. Revisar logs con `--verbose`.
- No prueba el camino de aprobación humana (`approval.js`).
- No prueba persistencia (Supabase está mockeado vía `pingSupabase`, pero
  ese helper no se llama en ningún `default`).

## Extender

Para agregar otro entrypoint:

1. Buscar el agente en `AGENT_SPECS` dentro de `sim-agents.mjs`.
2. Agregar un objeto al array `runs` con: `label`, `invoke(mod)`, `shapeCheck`,
   y opcionalmente `shapeKey` apuntando a un `SCHEMA_SAMPLES.<key>` que el
   stub usará como respuesta de Anthropic.
3. Si el shape es nuevo, agregarlo en `SCHEMA_SAMPLES` arriba del archivo.
