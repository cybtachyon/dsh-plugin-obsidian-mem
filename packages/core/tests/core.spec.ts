import { describe, expect, it } from 'vitest'
import plugin, { apply, inject, name } from '../src/index.ts'

/**
 * Scaffold smoke test: the package loads and exports the cordis plugin shape
 * {name, inject, apply} the Loader mounts. Phase 2 replaces this stub with the
 * real domain model and its own specs.
 */
describe('obsidian-mem core package', () => {
  it('exports the cordis plugin shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-core')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies as an inert no-op', () => {
    expect(() => plugin.apply({} as never)).not.toThrow()
  })
})
