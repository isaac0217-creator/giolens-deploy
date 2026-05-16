# GioLens — Agente QA · Simulación

Fase 3 GIOCORE · §15. **Sandbox-only, cero side-effects en producción.**

## Qué es

Agente que **valida** el comportamiento del resto del ecosistema GioLens
(5 motores conversacionales + Agentes Fase 3) corriendo evals deterministas,
tests semánticos y regression snapshots. **No** ejecuta acciones, **no** muta
estado y **no** toca APIs de producción.

## Tests que corre

1. **unit** — funciones puras (mode más rápido).
2. **integration** — tools encadenadas vía bus interno.
3. **e2e** — journey simulado INT1 → INT2 → INT3 (dry-run).
4. **evals** — golden suites en `/evals/golden/` vía `harness.js` (default).
5. **full** — todo lo anterior + regression snapshots + flag de blockers
   más estricto (también marca `high` como blocker).

## Uso

### CLI / cron

```js
import { executeQADailyRun } from './agents/qa/index.js';
const result = await executeQADailyRun();
if (result.summary.blockers > 0) process.exit(1); // bloquea promoción
```

### On-demand (Orquestador, tests, debugging)

```js
import { runQAOnDemand } from './agents/qa/index.js';

await runQAOnDemand({
  targets: ['216977', 'analista'], // subset
  mode: 'full',
});
```

### Shape del resultado

```js
{
  summary: { total, passed, failed, blockers },
  findings: [
    {
      severity: 'low' | 'medium' | 'high' | 'blocker',
      test_name: 'motor-justin-holbrook::jh-01-precio-rango',
      expected,
      actual,
      error_trace,
      suggested_fix,
      blocker: true | false,
    },
  ],
  cost_usd: number,
  latency_ms: number,
}
```

## Snapshots de regression

- Viven en `/agents/qa/snapshots/{motor}__{caseId}.json`.
- **Primer run**: si no existe, se crea automáticamente y el caso pasa neutral.
- **Runs posteriores**: deep-equal vs snapshot guardado; cualquier drift emite
  finding `medium`.
- El QA **NUNCA** sobreescribe un snapshot sin flag explícito. Para regenerar
  manualmente (después de un cambio intencional):

```js
import { saveSnapshot } from './agents/qa/runners/regression.js';
await saveSnapshot('216977', 'jh-01-precio-rango', nuevoOutput, { overwrite: true });
```

## Política de blockers

Un finding marca `blocker: true` cuando:

- `severity === 'blocker'` (runtime crash, tool que muta estado en read-only,
  drift en pipeline de producción).
- `mode === 'full'` **AND** `severity === 'high'` (fallo semántico repetible
  que afecta conversión).

Si `summary.blockers > 0`, el deploy script o el Orquestador **DEBE** detener
la promoción a producción. El humano (Isaac) revisa el reporte vía bus
(`type='qa_report'`) y decide.

## Restricciones inamovibles

- Solo opera en sandbox.
- Cero acceso a APIs de producción (Meta, Wapify, Anthropic con tráfico real).
- No escribe en Supabase.
- No envía WhatsApp, no publica anuncios.
- `sandbox_call` siempre inyecta `dry_run: true`.

## Tests del agente

```bash
# Vitest
npx vitest run agents/qa/__tests__/qa.test.js
```

Los tests mockean `callClaude`, `publish`, `trackCost`, `harness`, `runners`
y `regression` — son deterministas y no requieren `ANTHROPIC_API_KEY`.
