/**
 * Row-shape and registration-shape spec: the package exports the cordis
 * plugin row {name, inject, apply}; the three tool definitions built from
 * a fake seam carry the registered names, timeout budgets, closed oneOf
 * output unions, and generic-card presentCall views the host contract
 * expects. Live mounting is covered by mount.spec.ts on a real Context.
 */

import { describe, expect, it } from 'vitest'

import { TOOL_MEMORY_READ } from '../../core/lib/index.js'
import plugin, {
  createReadTool,
  READ_TIMEOUT_MS,
  registerMemoryTools,
} from '../src/index.ts'
import type { MemoryToolScope, ToolDefinition } from '../src/index.ts'
import { createFakeService, createRecordingScope } from './testkit.ts'

function fakeSeam() {
  return createFakeService({ vaults: [] })
}

describe('obsidian-mem tools package row', () => {
  it('exports the cordis plugin shape with the seam inject', () => {
    expect(plugin).toBeTypeOf('object')
    expect(plugin.name).toBe('obsidian-mem-tools')
    expect(plugin.inject).toEqual(['obsidianMem'])
    expect(plugin.apply).toBeTypeOf('function')
    expect(plugin).toEqual({
      name: plugin.name,
      inject: plugin.inject,
      apply: plugin.apply,
    })
  })

  it('registers read, search, and write in order through the scope effect', () => {
    const scope = createRecordingScope()
    registerMemoryTools(scope as unknown as MemoryToolScope, fakeSeam())
    expect(scope.registered.map((definition) => definition.name))
      .toEqual([TOOL_MEMORY_READ])
    // Every registration is effect-owned: running the disposers unregisters
    // exactly the registered names (row unload closes the tool set).
    for (const dispose of scope.effectDisposers) {
      dispose()
    }
    expect(scope.disposed).toEqual([TOOL_MEMORY_READ])
  })
})

describe('memory_read definition shape', () => {
  const definition: ToolDefinition = createReadTool(fakeSeam())

  it('carries the read timeout and a required-path parameter', () => {
    expect(definition.timeoutMs).toBe(READ_TIMEOUT_MS)
    expect(READ_TIMEOUT_MS).toBe(10_000)
    expect(definition.parameters.required).toEqual(['path'])
    expect(Object.keys(definition.parameters.properties ?? {})).toEqual(['path', 'offset', 'limit'])
    for (const spec of Object.values(definition.parameters.properties ?? {})) {
      expect(spec.description).toBeTruthy()
    }
  })

  it('declares a closed oneOf output keyed on kind', () => {
    const kinds = (definition.output.schema.oneOf ?? [])
      .map((member) => member.properties?.kind?.const)
    expect(kinds).toEqual(['read', 'outside_vault', 'not_found'])
  })

  it('presents a generic read card', () => {
    const view = definition.presentCall?.({ path: '/v/markdown/a.md' })
    expect(view).toEqual({
      card: 'generic',
      kind: 'read',
      title: `${TOOL_MEMORY_READ} /v/markdown/a.md`,
      rawInput: { path: '/v/markdown/a.md' },
    })
  })
})
