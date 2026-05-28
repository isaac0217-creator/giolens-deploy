// vitest.config.js — Configuración Vitest para GioLens
// Tests bajo agents/ y evals/. Excluye templates y snapshots.
// Coverage v8 con umbral suave (lines 50%) — se irá endureciendo por fase.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'agents/**/*.test.{js,ts}',
      'evals/**/*.test.{js,ts}',
      'inngest/**/*.test.{js,ts}',
      'tests/**/*.test.{js,ts}',
    ],
    exclude: ['node_modules', '**/templates/**', '**/snapshots/**'],
    setupFiles: ['./vitest.setup.js'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['agents/**/*.js', 'evals/**/*.js'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.js',
        '**/templates/**',
        '**/snapshots/**',
        'evals/golden/**',
      ],
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 40,
        branches: 40,
      },
    },
  },
});
