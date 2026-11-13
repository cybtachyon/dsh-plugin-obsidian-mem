import { describe, expect, it } from 'vitest'
import plugin, { apply, inject, name } from '../src/index.ts'

/**
 * Scaffold smoke test: the package loads and exports the cordis plugin shape
 * {name, inject, apply} the Loader mounts. The /obsidian-mem/* routes land
 * with TASK-050.
 */
describe('obsidian-mem ui package', () => {
  it('exports the cordis plugin shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-ui')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies as an inert no-op', () => {
    expect(() => plugin.apply({} as never)).not.toThrow()
  })
})
