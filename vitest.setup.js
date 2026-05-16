// vitest.setup.js — Hooks globales para todos los tests GioLens.
//
// Se ejecuta una vez por archivo de test ANTES de los tests del archivo.
// Mantener este archivo mínimo: lo que se mockee aquí afecta a todo el suite.
//
// TODO (futuro):
//   - Mock global de `fetch` para correr tests offline sin Wapify ni Meta.
//       global.fetch = vi.fn(async (url, init) => { ... });
//   - Mock del cliente Anthropic (agents/_shared/anthropic.js) cuando
//     existan tests de motores/agentes que llamen a Claude.
//   - Stub de `process.env` con valores deterministas (ANTHROPIC_API_KEY=test,
//     SUPABASE_URL=http://localhost, etc.) para evitar leer credenciales reales.
//   - Hook `beforeEach` que limpie el bus in-memory de /agents/_shared/bus.js
//     entre tests para evitar contaminación cruzada.
//   - Hook `afterAll` que verifique que no quedaron timers/listeners colgados.
//
// Por ahora no se mockea nada: cada test maneja sus propios mocks con vi.fn().

// Marca útil si algún test quiere saber que corre bajo Vitest.
process.env.GIOLENS_TEST = '1';
