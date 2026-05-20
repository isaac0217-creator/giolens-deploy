# CHANGELOG · giolens_deploy

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/)

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
