import { defineConfig } from 'vitest/config'

// Tests import package sources through relative paths (../src/index.ts), never
// bare self-references: this repo has no `paths` map and cross-package imports
// go through relative lib paths, so Vite needs no aliasing layer here (unlike
// dsh-plugin-local-infer, whose tests resolve bare subpath specifiers).
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Project bar (TASK-060): measured totals sit ~4pt above these
      // floors (lines 93+ / functions 89+ / branches 86+ / statements
      // 93+), so these uniform floors guard against regress without
      // forcing theater. Per-package exceptions kept below the bar by
      // design, listed here because the thresholds are global:
      // - client/src: `card.ts` (3-line mount glue), `react.ts` (the
      //   frozen-platform-table require shim: it only runs inside the
      //   shell's ModuleLoader), and the styles.ts lambda are browser-
      //   runtime glue; unit-asserting them tests the fake, not code
      //   that ships (the real gate is scripts/build-client.mjs +
      //   bundle.spec).
      // - `packages/{core,service}/src/index.ts`: pure re-export
      //   barrels; no behavior to assert.
      // - service/src/service.ts (~81%): the degraded-teardown and
      //   dream-gateway branches that need a live cordis ctx; the
      //   integration tier (tests/integration, RUN_LIVE=1) exercises
      //   the happy provisioning path for real.
      thresholds: { lines: 85, functions: 85, branches: 78, statements: 85 },
    },
  },
})
