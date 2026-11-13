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
      // Scaffold-era thresholds: the stubs are near-trivially covered by the
      // per-package smoke specs, and these floors only guard against regress
      // during scaffolding. TASK-060 raises them to the project's real bar.
      thresholds: { lines: 75, functions: 75, branches: 70, statements: 75 },
    },
  },
})
