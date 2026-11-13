/**
 * Bundle-artifact tests (TASK-052 DoD): dsh/client.js must exist, carry the
 * window.__ModuleLoader__.load contract with this bundle's id, and keep the
 * two runtime externals as bare requires (never bundled, never an ESM
 * import, never the react/jsx-runtime automatic path the frozen platform
 * module table cannot resolve). The artifact is build output: run after
 * `pnpm build` (the same order the repo's other lib-consuming suites
 * already assume).
 * @module dsh-plugin-obsidian-mem/client/tests/bundle
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const artifact = readFileSync(
  join(process.cwd(), 'dsh/client.js'),
  'utf8',
)

describe('dsh/client.js ModuleLoader contract', () => {
  it('parses as syntactically clean JavaScript', () => {
    // new Function compiles without executing: the window reference the
    // artifact starts with is never resolved.
    expect(() => new Function(artifact)).not.toThrow()
  })

  it('loads through the ModuleLoader with the bare package id', () => {
    expect(artifact).toContain(
      "window.__ModuleLoader__.load({ id: 'dsh-plugin-obsidian-mem', factory: (require) => {",
    )
    expect(artifact).toContain('return module.exports;')
  })

  it('keeps react and the primitives as runtime requires of the frozen table', () => {
    expect(artifact).toContain('require("react")')
    expect(artifact).toContain('require("@deepseek-ai/dsh-client-ui-primitives")')
  })

  it('bundles no react at all and never touches the automatic JSX runtime', () => {
    expect(artifact).not.toContain('react/jsx-runtime')
    expect(artifact).not.toContain('jsxRuntime')
    // ESM import statements must not survive the CJS bundle: the only
    // `import` token allowed is inside strings, so anchor on statement form.
    expect(artifact).not.toMatch(/^\s*import\s*[({"']/m)
    expect(artifact).not.toMatch(/^\s*export\s/m)
  })

  it('ships the card surface: section copy reaches the bundle', () => {
    expect(artifact).toContain('obsidian-mem-vault-mode')
    expect(artifact).toContain('obsidian-mem-audit-view')
    expect(artifact).toContain('Adopt and Share')
    expect(artifact).toContain('Dreaming triggers')
    // TASK-010: the add-form global-file copy must survive bundling.
    expect(artifact).toContain('Global memory relative file path e.g. GLOBAL.md')
  })
})
