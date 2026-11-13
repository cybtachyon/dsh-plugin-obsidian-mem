import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'

/**
 * Package-root smoke test: the entry re-exports the domain modules so
 * consumers importing '../../core/lib/index.js' see one surface. The
 * scaffold's cordis plugin-stub spec retired with TASK-010: core is a pure
 * library and cordis.patch.yml never mounts it.
 */
describe('obsidian-mem core package', () => {
  it('re-exports the constants module from the package root', () => {
    expect(core.INTENT_MARKERS).toBeTypeOf('object')
    expect(core.SCOPE_GLOBAL).toBe('global')
    expect(core.PLUGIN_SOURCE_KIND).toBe('plugin:obsidian-mem')
    expect(core.approxTokens('aaaa')).toBe(1)
    expect(core.MILVUS_COLLECTION).toBe('obsidian_mem')
  })

  it('re-exports the vaults and note modules from the package root', () => {
    expect(core.resolveVaults).toBeTypeOf('function')
    expect(core.classifyPath).toBeTypeOf('function')
    expect(core.parseNote).toBeTypeOf('function')
    expect(core.titleToFilename).toBeTypeOf('function')
  })

  it('carries no cordis plugin shape', () => {
    expect(core).not.toHaveProperty('inject')
    expect(core).not.toHaveProperty('apply')
  })
})
