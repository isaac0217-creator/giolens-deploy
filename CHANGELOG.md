# CHANGELOG · giolens_deploy

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/)

---

## [C.3-C.5] - 2026-05-21

### Added

- `agents/_shared/approval-store.js` — store in-memory de decisiones del gate de aprobación (register/waitFor/resolve/getPending/getHistory); espejo de la futura tabla `agent_decisions` de Supabase
- `agents/_shared/__tests__/approval.test.js` — 7 tests del gate (modos AUTO/GATE, umbral, timeout, idempotencia)
- `scripts/smoke-shadow-analista.mjs` + script npm `smoke:shadow` — smoke C.4: valida shadow ≡ Inngest del Analista e idempotencia cross-run, costo Anthropic 0
- `docs/frente_c_v2_handoff.md` — handoff de cierre con TODOs diferidos

### Changed

- **C.3** — `agents/_shared/approval.js`: deja de ser stub auto-aprueba. Gate real backend: modo GATE publica al bus (`panel-aprobaciones`) y bloquea hasta veredicto humano; modo AUTO (kill-switch `APPROVAL_AUTO_MODE`, default) auto-aprueba; auto-aprobación bajo umbral `APPROVAL_GATE_THRESHOLD_USD`; timeout opcional

### Notes

- **C.3 alcance:** la UI/SSE del panel se difiere al track dashboard web (ver ADR-01 en el vault). El núcleo entrega el backend del gate y el contrato de bus
- `APPROVAL_AUTO_MODE` default-true: imprescindible para no colgar `sim-agents` ni los runs reales mientras el panel humano no esté conectado
- **C.4** — `run-arbitraje` ya invocaba `executeAnalistaDailyRun`; el smoke confirma equivalencia shadow/Inngest
- Tests al cierre: vitest 214/214 · sim-agents 12/12 · smoke:inngest PASS · smoke:shadow PASS
- Frente C v2 cerrado a nivel núcleo (C.1–C.5)

---

## [C.2.6] - 2026-05-20

### Added

- `scripts/smoke-inngest-e2e.mjs` — smoke E2E del wiring Inngest que valida la cascada completa `message_received → silence_detected → reactivation_sent` con correlation_id compartido (`9c0faf0`)
- Script npm `smoke:inngest` en `package.json` (`9c0faf0`)

### Changed

- Wiring de 5 Inngest functions conectado a agents reales; cascada E2E verificada en dry_run (`9c0faf0`)

### Notes

- Pipelines prohibidos (252999 SPY / 273944 GioVision) correctamente excluidos por la regla inviolable
- Tests al cierre: vitest 207/207 · sim-agents 12/12 · smoke:inngest PASS
- Frente C.2 cerrado (7/7 sub-fases: C.2.1–C.2.7); siguiente: C.3 panel aprobaciones
