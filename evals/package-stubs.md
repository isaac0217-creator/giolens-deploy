# /evals — Dependencias futuras (stubs, NO instalar todavía)

Cuando esta carpeta se integre con Vitest/Anthropic oficiales, añadir a
`package.json` raíz:

```json
{
  "scripts": {
    "evals": "node evals/run-all.js",
    "evals:live": "LIVE=1 node evals/run-all.js",
    "evals:vitest": "vitest run evals"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0"
  }
}
```

## Por qué cada dep

| Dep                       | Cuándo                                                                   | Por qué                                                                                          |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `vitest`                  | Cuando queramos `describe/it/expect` y reportes JUnit para CI            | El harness actual usa `console.log` + exit code. Vitest da watcher, snapshots y reporter HTML.   |
| `@anthropic-ai/sdk`       | Cuando activemos LIVE=1 para validar comportamiento real del modelo      | Hoy `runners/motor-runner.js` deja un stub `callLive()`. Migrarlo al SDK oficial.                |

## NO instalar todavía

Sprint 6 pide solo el flujo del loop y la estructura de evals. La integración
real con Vitest y el SDK es Fase 3 (sem 7-10) junto con los agentes Dev y QA
reales.
