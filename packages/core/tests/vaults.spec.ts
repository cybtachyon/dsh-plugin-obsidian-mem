import { describe, expect, it } from 'vitest'
import {
  GLOBAL_MEMORY_FILE_DEFAULT,
  INTENT_MARKERS,
  INTENTS_FILE,
} from '../src/constants.ts'
import {
  classifyPath,
  firstSharedVault,
  globalFilePath,
  isPluginInternalPath,
  metadataDir,
  pluginDir,
  provisionDefaultVault,
  resolveVaults,
  seedIntentsFile,
  VAULT_MODE_SHARED,
  VAULT_MODES,
  VAULT_MODE_READ_ONLY,
} from '../src/vaults.ts'
import type { VaultConfig, VaultFs } from '../src/vaults.ts'

/**
 * In-memory VaultFs stub: directories, files, and an optional symlink table
 * feed realpath. writeCalls counts writeFile invocations so specs can prove
 * "zero side effects" and "never rewrites" instead of eyeballing state.
 */
class MemoryFs implements VaultFs {
  readonly dirs = new Set<string>()
  readonly files = new Map<string, string>()
  readonly links = new Map<string, string>()
  writeCalls = 0
  mkdirCalls = 0

  constructor(seedDirs: string[] = []) {
    for (const dir of seedDirs) {
      this.dirs.add(dir)
    }
  }

  /** Registers a link: path resolves to target under realpath. */
  link(path: string, target: string): void {
    this.links.set(path, target)
    this.dirs.add(path)
  }

  exists(path: string): boolean {
    return this.dirs.has(this.realpath(path)) || this.dirs.has(path)
      || this.files.has(path)
  }

  realpath(path: string): string {
    return this.links.get(path) ?? path
  }

  mkdirp(path: string): void {
    this.mkdirCalls += 1
    this.dirs.add(path)
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null
  }

  writeFile(path: string, contents: string): void {
    this.writeCalls += 1
    this.files.set(path, contents)
  }
}

const HOME = '/home/tester'
const DEFAULT_VAULT = `${HOME}/.dsh/obsidian-mem`

describe('resolveVaults', () => {
  it('keeps existing absolute vaults in input order', () => {
    const fs = new MemoryFs(['/vaults/team', '/vaults/personal'])
    const result = resolveVaults([
      { path: '/vaults/team', mode: VAULT_MODE_SHARED },
      { path: '/vaults/personal', mode: VAULT_MODE_READ_ONLY },
    ], fs)

    expect(result.vaults).toEqual([
      { path: '/vaults/team', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      { path: '/vaults/personal', mode: VAULT_MODE_READ_ONLY, globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    ])
    expect(result.hasSharedVault).toBe(true)
    expect(result.rejected).toEqual([])
  })

  it('has zero fs side effects: nothing is created or written', () => {
    const fs = new MemoryFs(['/vaults/team'])
    resolveVaults([
      { path: '/vaults/team', mode: VAULT_MODE_SHARED },
      { path: '/vaults/missing', mode: VAULT_MODE_SHARED },
    ], fs)

    expect(fs.mkdirCalls).toBe(0)
    expect(fs.writeCalls).toBe(0)
    expect(fs.dirs).toEqual(new Set(['/vaults/team']))
    expect(fs.files.size).toBe(0)
  })

  it('reports hasSharedVault false for an empty or read-only registry', () => {
    const fs = new MemoryFs(['/vaults/ro'])
    expect(resolveVaults([], fs).hasSharedVault).toBe(false)
    expect(resolveVaults(
      [{ path: '/vaults/ro', mode: VAULT_MODE_READ_ONLY }],
      fs,
    ).hasSharedVault).toBe(false)
    expect(fs.mkdirCalls).toBe(0)
  })

  it('rejects relative paths, invalid modes, missing dirs, duplicates', () => {
    const fs = new MemoryFs(['/vaults/team'])
    fs.link('/links/team', '/vaults/team')
    const result = resolveVaults([
      { path: 'vaults/relative', mode: VAULT_MODE_SHARED },
      { path: '/vaults/team-x', mode: 'ReadWrite' },
      { path: '/vaults/missing', mode: VAULT_MODE_SHARED },
      { path: '/links/team', mode: VAULT_MODE_SHARED },
      { path: '/vaults/team', mode: VAULT_MODE_SHARED },
    ], fs)

    expect(result.vaults).toEqual([
      { path: '/vaults/team', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    ])
    expect(result.rejected.map((entry) => entry.kind)).toEqual([
      'path-not-absolute', 'mode-invalid', 'path-missing', 'duplicate',
    ])
  })

  it('de-dupes by realpath, keeping the first occurrence', () => {
    const fs = new MemoryFs(['/vaults/team'])
    fs.link('/links/team', '/vaults/team')
    const result = resolveVaults([
      { path: '/links/team', mode: VAULT_MODE_SHARED },
      { path: '/vaults/team', mode: VAULT_MODE_READ_ONLY },
    ], fs)

    expect(result.vaults).toEqual([
      { path: '/vaults/team', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    ])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.kind).toBe('duplicate')
  })

  it('accepts exactly the two declared VAULT_MODES values', () => {
    expect(VAULT_MODES).toEqual([VAULT_MODE_SHARED, VAULT_MODE_READ_ONLY])
    const fs = new MemoryFs(['/vaults/a', '/vaults/b'])
    const result = resolveVaults([
      { path: '/vaults/a', mode: VAULT_MODES[0] },
      { path: '/vaults/b', mode: VAULT_MODES[1] },
    ], fs)

    expect(result.rejected).toEqual([])
    expect(result.vaults).toHaveLength(2)
  })

  it('defaults blank or omitted globalFile and keeps an explicit one', () => {
    const fs = new MemoryFs(['/vaults/a', '/vaults/b', '/vaults/c'])
    const result = resolveVaults([
      { path: '/vaults/a', mode: VAULT_MODE_SHARED },
      { path: '/vaults/b', mode: VAULT_MODE_SHARED, globalFile: '  ' },
      { path: '/vaults/c', mode: VAULT_MODE_SHARED, globalFile: ' notes/GLOBALS.md ' },
    ], fs)

    expect(result.vaults.map((vault) => vault.globalFile)).toEqual([
      GLOBAL_MEMORY_FILE_DEFAULT,
      GLOBAL_MEMORY_FILE_DEFAULT,
      'notes/GLOBALS.md',
    ])
  })
})

describe('vault dir accessors', () => {
  it('join the plugin-internal layout subdirs onto a vault root', () => {
    expect(pluginDir('/vaults/team')).toBe('/vaults/team/.obsidian-mem')
    expect(metadataDir('/vaults/team')).toBe('/vaults/team/.obsidian-mem/metadata')
  })

  it('isPluginInternalPath covers the plugin dir subtree and nothing else', () => {
    expect(isPluginInternalPath('/vaults/team', '/vaults/team/.obsidian-mem/metadata/DREAMS.md'))
      .toBe(true)
    expect(isPluginInternalPath('/vaults/team', '/vaults/team/.obsidian-mem')).toBe(true)
    expect(isPluginInternalPath('/vaults/team', '/vaults/team/topic.md')).toBe(false)
    // A sibling whose name merely starts with the plugin dir name stays out.
    expect(isPluginInternalPath('/vaults/team', '/vaults/team/.obsidian-memx/x.md')).toBe(false)
  })
})

describe('globalFilePath', () => {
  it('joins the vault globalFile onto the vault root, flat or nested', () => {
    expect(globalFilePath({ path: '/vaults/team', globalFile: GLOBAL_MEMORY_FILE_DEFAULT }))
      .toBe('/vaults/team/GLOBAL.md')
    expect(globalFilePath({ path: '/vaults/team', globalFile: 'notes/MAIN.md' }))
      .toBe('/vaults/team/notes/MAIN.md')
  })

  it('answers null when the joined path escapes the vault root', () => {
    // Hand-edited registries reach this belt after config validation.
    expect(globalFilePath({ path: '/vaults/team', globalFile: '../elsewhere/GLOBAL.md' })).toBeNull()
    expect(globalFilePath({ path: '/vaults/team', globalFile: '.' })).toBeNull()
    expect(globalFilePath({ path: '/vaults/team', globalFile: 'notes/../../GLOBAL.md' })).toBeNull()
  })
})

describe('provisionDefaultVault', () => {
  it('creates the vault tree lazily and returns the shared config', () => {
    const fs = new MemoryFs()
    const vault = provisionDefaultVault(fs, HOME)

    expect(vault).toEqual({
      path: DEFAULT_VAULT,
      mode: VAULT_MODE_SHARED,
      globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    })
    // The vault root IS the note root: only root + sidecar dirs get created.
    expect(fs.dirs).toEqual(new Set([
      DEFAULT_VAULT,
      `${DEFAULT_VAULT}/.obsidian-mem/metadata`,
    ]))
    expect(fs.writeCalls).toBe(0)
  })

  it('is safe to call again: provisioning only adds nothing', () => {
    const fs = new MemoryFs()
    provisionDefaultVault(fs, HOME)
    const second = provisionDefaultVault(fs, HOME)

    expect(second).toEqual({
      path: DEFAULT_VAULT,
      mode: VAULT_MODE_SHARED,
      globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    })
    expect(fs.dirs.size).toBe(2)
  })

  it('stays the only creator: an empty registry never touches the fs', () => {
    const fs = new MemoryFs()
    const empty = resolveVaults([], fs)
    expect(empty.hasSharedVault).toBe(false)
    expect(fs.mkdirCalls).toBe(0)

    provisionDefaultVault(fs, HOME)
    expect(fs.mkdirCalls).toBe(2)
  })
})

describe('firstSharedVault', () => {
  const shared: VaultConfig = {
    path: '/vaults/a', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
  }
  const readOnly: VaultConfig = {
    path: '/vaults/b', mode: VAULT_MODE_READ_ONLY, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
  }

  it('takes the first shared vault in list order', () => {
    expect(firstSharedVault([readOnly, shared, {
      path: '/vaults/c', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    }])).toEqual(shared)
  })

  it('keeps read-only vaults out of the shared answer', () => {
    expect(firstSharedVault([readOnly])).toBeNull()
    expect(firstSharedVault([])).toBeNull()
  })
})

describe('classifyPath', () => {
  const shared: VaultConfig = {
    path: '/vaults/team', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
  }
  const readOnly: VaultConfig = {
    path: '/vaults/docs', mode: VAULT_MODE_READ_ONLY, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
  }
  const vaults = [shared, readOnly]

  it('maps a root note path to its vault, mode, and note membership', () => {
    expect(classifyPath(vaults, '/vaults/team/topic.md')).toEqual({
      vault: shared,
      mode: VAULT_MODE_SHARED,
      insideNotes: true,
    })
    // Nested dirs inside the vault root are indexed notes dirs too.
    expect(classifyPath(vaults, '/vaults/team/sub/topic.md')?.insideNotes).toBe(true)
    expect(classifyPath(vaults, '/vaults/docs/ref.md')?.mode)
      .toBe(VAULT_MODE_READ_ONLY)
  })

  it('refuses plugin-internal and dot-dir paths', () => {
    expect(classifyPath(vaults, '/vaults/team/.obsidian-mem/metadata/DREAMS.md')?.insideNotes)
      .toBe(false)
    expect(classifyPath(vaults, '/vaults/team/.obsidian/workspace.json')?.insideNotes)
      .toBe(false)
    expect(classifyPath(vaults, '/vaults/team/.hidden.md')?.insideNotes).toBe(false)
  })

  it('refuses the reserved root files and the vault root itself', () => {
    expect(classifyPath(vaults, `/vaults/team/${INTENTS_FILE}`)).toEqual({
      vault: shared,
      mode: VAULT_MODE_SHARED,
      insideNotes: false,
    })
    expect(classifyPath(vaults, '/vaults/team/DREAMS.md')?.insideNotes).toBe(false)
    expect(classifyPath(vaults, '/vaults/team/topic_history.md')?.insideNotes).toBe(false)
    expect(classifyPath(vaults, '/vaults/team')?.insideNotes).toBe(false)
  })

  it('returns null outside every vault and for relative paths', () => {
    expect(classifyPath(vaults, '/elsewhere/notes.md')).toBeNull()
    expect(classifyPath(vaults, 'notes.md')).toBeNull()
    // A prefix of a vault name is not inside it.
    expect(classifyPath(vaults, '/vaults/teamwork/x.md')).toBeNull()
  })

  it('lets a nested vault claim its own files', () => {
    const outer: VaultConfig = {
      path: '/vaults', mode: VAULT_MODE_READ_ONLY, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    }
    const inner: VaultConfig = {
      path: '/vaults/team', mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    }
    const nested = classifyPath([outer, inner], '/vaults/team/topic.md')

    expect(nested?.vault).toEqual(inner)
    expect(nested?.mode).toBe(VAULT_MODE_SHARED)
    // The outer vault still answers for its own files.
    expect(classifyPath([outer, inner], '/vaults/other.md')?.vault).toEqual(outer)
  })
})

describe('seedIntentsFile', () => {
  it('creates the file with one section per intent marker', () => {
    const fs = new MemoryFs()
    const result = seedIntentsFile(fs, DEFAULT_VAULT)
    const contents = fs.readFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`)

    expect(result).toEqual({ path: `${DEFAULT_VAULT}/${INTENTS_FILE}`, created: true })
    expect(contents).not.toBeNull()
    for (const marker of INTENT_MARKERS) {
      expect(contents).toContain(`## ${marker}\n`)
    }
    expect(fs.writeCalls).toBe(1)
  })

  it('renders a non-empty hint paragraph under every intent marker', () => {
    const fs = new MemoryFs()
    seedIntentsFile(fs, DEFAULT_VAULT)
    const contents = fs.readFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`) ?? ''

    for (const marker of INTENT_MARKERS) {
      // Section body: what stands between this marker's line and the
      // next '## ' header.
      const body = (contents.split(`## ${marker}\n`)[1] ?? '').split('##')[0] ?? ''
      expect(body.trim(), `section ${marker}`).not.toBe('')
    }
  })

  it('is idempotent: an existing file is never rewritten', () => {
    const fs = new MemoryFs()
    seedIntentsFile(fs, DEFAULT_VAULT)
    const first = fs.readFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`)
    const second = seedIntentsFile(fs, DEFAULT_VAULT)

    expect(second.created).toBe(false)
    expect(fs.writeCalls).toBe(1)
    expect(fs.readFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`)).toBe(first)
  })

  it('leaves hand-edited intent files untouched', () => {
    const fs = new MemoryFs()
    fs.writeFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`, '# my own intents\n')
    seedIntentsFile(fs, DEFAULT_VAULT)

    expect(fs.readFile(`${DEFAULT_VAULT}/${INTENTS_FILE}`)).toBe('# my own intents\n')
    expect(fs.writeCalls).toBe(1)
  })
})
