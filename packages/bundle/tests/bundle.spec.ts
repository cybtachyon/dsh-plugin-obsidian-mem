import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import hostCarrier, { apply, inject, name } from '../../../dsh/host.js'

/** One `insert` row of a cordis.patch.yml file. */
interface PatchRow {
  id: string
  name: string
  inject?: string[]
}

/**
 * patchRows returns the insert rows of one patch file copy. Each copy is a
 * single layer whose `insert` list mounts the bundle's rows; the two copies
 * differ only in their header comments.
 */
function patchRows(patchFile: string): PatchRow[] {
  const here = fileURLToPath(new URL('../../../', import.meta.url))
  const [layer] = parseYaml(readFileSync(`${here}${patchFile}`, 'utf8')) as [
    { insert: PatchRow[] },
  ]
  return layer.insert
}

/** The five rows the bundle mounts, in the canonical order. */
const expectedRows: PatchRow[] = [
  { id: 'obsidian-mem', name: 'dsh-plugin-obsidian-mem' },
  { id: 'obsidian-mem-service', name: 'dsh-plugin-obsidian-mem/service' },
  { id: 'obsidian-mem-ui', name: 'dsh-plugin-obsidian-mem/ui' },
  {
    id: 'obsidian-mem-tools',
    name: 'dsh-plugin-obsidian-mem/tools',
    inject: ['obsidianMem'],
  },
  {
    id: 'obsidian-mem-events',
    name: 'dsh-plugin-obsidian-mem/events',
    inject: ['obsidianMem'],
  },
]

describe('obsidian-mem bundle', () => {
  it('parses both patch copies into the same five rows', () => {
    expect(patchRows('cordis.patch.yml')).toEqual(expectedRows)
    expect(patchRows('packages/bundle/cordis.patch.yml')).toEqual(expectedRows)
  })

  it('ships the bare-package host carrier the client-module scan keys on', () => {
    // The carrier row names the bare package; its module must be the no-op
    // plugin shape named after the row id, or dsh/client.js never loads.
    expect(name).toBe('obsidian-mem')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
    expect(hostCarrier).toEqual({ name, inject, apply })
    expect(() => hostCarrier.apply({} as never)).not.toThrow()
  })
})
