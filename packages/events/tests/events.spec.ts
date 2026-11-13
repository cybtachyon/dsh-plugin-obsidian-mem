import { describe, expect, it } from 'vitest'
import plugin, { apply, inject, name } from '../src/index.ts'

/**
 * Scaffold smoke test: the package loads and exports the cordis plugin shape
 * {name, inject, apply}, and its scaffold inject pins the seam contract: the
 * lifecycle hooks (TASK-040..045) mount against ctx.obsidianMem.
 */
describe('obsidian-mem events package', () => {
  it('exports the cordis plugin shape with the seam inject', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-events')
    expect(inject).toEqual(['obsidianMem'])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies as an inert no-op', () => {
    expect(() => plugin.apply({} as never)).not.toThrow()
  })
})
