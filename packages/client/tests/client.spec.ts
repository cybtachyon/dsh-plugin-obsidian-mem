import { describe, expect, it } from 'vitest'
import plugin, { apply, inject, name } from '../src/index.ts'

/**
 * Scaffold smoke test: the client package compiles and exports the cordis
 * plugin shape. The browser card itself (TASK-051) replaces this stub and
 * switches scripts/build-client.mjs on via its card.ts(x) marker.
 */
describe('obsidian-mem client package', () => {
  it('exports the cordis plugin shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-client')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies as an inert no-op', () => {
    expect(() => plugin.apply({} as never)).not.toThrow()
  })
})
