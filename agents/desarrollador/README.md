# Agente Desarrollador — GioLens (Fase 3 · GIOCORE)

Cuarto agente de la Fase 3. **Riesgo medio**: genera y modifica código del propio núcleo. Conecta APIs nuevas. Corrige bugs reportados por QA. **NUNCA hace push directo a `main`**.

## Qué hace

3 flujos bajo demanda, todos producen DRAFTS:

| Flujo | Función | Input | Output |
|---|---|---|---|
| (1) | `analyzeQAFailure` | `{ qaIssue }` (formato §16 v12) | `diagnosis` + `root_cause` + `suggested_patches` + `confidence` + `requires_human` |
| (2) | `generateFix` | `{ filePath, currentContent?, diagnosis, rootCause }` | `patch (old→new)` + `tests_to_add` + `rollback_plan` + `status='draft'` |
| (3) | `createPullRequestStub` | `{ branchName, baseBranch?, fixPayload, qaIssueRef? }` | `pr_url='stub://...'` + `title` + `body_markdown` + `files_changed` |

Cada draft se publica al bus con `status='draft'` (o `'open'` para PR) + `requires_approval=true`. Se solicita aprobación vía `requestApproval` (stub auto-aprueba en Fase 1).

## Restricciones inamovibles

1. **No publica a `main`.** Cambios solo se mergean tras:
   - QA pasa,
   - humano revisa PR,
   - tests verdes en CI.
2. **No escribe a disco.** `read_repo_file` es read-only. `propose_patch` queda en buffer in-memory.
3. **No conecta a GitHub real.** El PR es STUB (`pr_url='stub://...'`) hasta Fase 4+.
4. **Override defensivo** `requires_human=true` cuando el fix toca:
   - `agents/_shared/`
   - `api/webhook.js`
   - `.env*`
   - `package.json`
   - `vercel.json`
5. **Override defensivo** `requires_human=true` cuando `severity='critical'` o `confidence<0.6`.

## Cómo aprobar un draft y mergearlo

1. Observar `draft.fix` / `draft.pull_request` en el bus (o en el dashboard widget Fase 2).
2. Inspeccionar `patch.old` y `patch.new` línea por línea.
3. Si OK, aplicar manualmente con `git apply` o copy-paste, commitear en branch nueva.
4. Abrir PR real en GitHub apuntando al `base_branch` indicado.
5. Esperar CI verde + review humano + QA pasa → merge.

## Archivos

| Archivo | Rol |
|---|---|
| `prompt.js` | `SYSTEM_PROMPT` del Desarrollador (identidad, formato JSON, restricciones) |
| `tools.js` | Tools Anthropic (`read_repo_file`, `propose_patch`) + handlers `saveDraftFix`, `saveDraftPR` + `isSensitivePath` |
| `graph.js` | Orquestación de los 3 flujos + helpers de parse/cost |
| `index.js` | `executeDesarrolladorOnDemand({ task, params })` — handler exportable |
| `__tests__/desarrollador.test.js` | Tests Vitest con mocks (cubre 3 flujos + sensitive paths + dispatcher) |

## Cómo invocar (local)

```bash
# (1) Diagnosticar una falla QA
node -e "import('./index.js').then(m=>m.default({
  task: 'analyze_qa_failure',
  params: { qaIssue: {
    test_name: 'analista.test.js > pickInsight',
    expected: 'fatiga seleccionada',
    actual: 'null',
    error_trace: 'TypeError: ... reading severity',
    severity: 'medium'
  }}
}))"

# (2) Generar fix para un archivo
node -e "import('./index.js').then(m=>m.default({
  task: 'generate_fix',
  params: {
    filePath: 'agents/analista/graph.js',
    currentContent: '...',
    diagnosis: 'pickInsight no maneja metric=null',
    rootCause: 'null_dereference'
  }
}))"

# (3) Empacar fix en PR stub
node -e "import('./index.js').then(m=>m.default({
  task: 'create_pull_request',
  params: {
    branchName: 'fix/analista-null-metric',
    baseBranch: 'main',
    fixPayload: { task: 'generate_fix', file_path: 'agents/analista/graph.js' },
    qaIssueRef: 'qa-issue-001'
  }
}))"
```

## Dependencias / stubs requeridos

Este agente NO crea código en `/agents/_shared/`. Asume estos exports:

- `_shared/anthropic.js` → `callClaude({ model, system, tools, messages, max_tokens })`
- `_shared/bus.js` → `publish({ from_agent, to_agent, type, payload, ... })`
- `_shared/cost-tracker.js` → `track(agent, usage, model)`
- `_shared/approval.js` → `requestApproval({ decision_id, agent, action, rationale, evidence })`

## Modelo

`claude-opus-4-5` (§15 HTML maestro v12). Es la diferencia entre código limpio y código que se rompe — el Desarrollador es el único agente Fase 3 que usa Opus (los demás van Sonnet/Haiku).

## Pendientes

- `// TODO Fase 2`: envolver `executeDesarrolladorOnDemand` en `inngest.createFunction`.
- `// TODO Fase 2`: migrar `graph.js` a LangGraph `StateGraph`.
- `// TODO Fase 2`: reemplazar `requestApproval` stub por dashboard widget que bloquee hasta input humano.
- `// TODO Fase 4`: `createPullRequestReal` con GitHub API + branch protection en `main`.
- `// TODO Fase 4`: tool `apply_patch_to_disk` (gated, solo en sandbox) + integración con `git apply`.
- `// TODO`: persistir runs/drafts en Supabase (`agent_runs`, `agent_drafts`, `agent_prs`).
