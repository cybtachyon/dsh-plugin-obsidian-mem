import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  defaultVaultPath,
  INTENT_MARKERS,
  INTENTS_FILE,
  modelCacheDir,
  renderIntentsFile,
  serializeNoteWithRaw,
} from '../../core/lib/index.js'
import type { NoteMeta } from '../../core/lib/index.js'
import { inventoryVault, nodeAuditFs, runStoreAudit } from '../src/audit.ts'
import type { AuditFs, AuditReport, CollectionProbeResult } from '../src/audit.ts'
import { resolveServiceConfig, validateObsidianMemConfig } from '../src/config.ts'
import type { ObsidianMemConfig } from '../src/config.ts'
import { STATE_FILE_NAME } from '../src/indexer.ts'
import { ObsidianMemService } from '../src/service.ts'
import type { ObsidianMemStatus, ServiceFs, VaultEntry } from '../src/service.ts'

/**
 * Report-shape tests for the TASK-034 read-only audit engine, run against
 * fixture services (an in-memory AuditFs plus canned status/probe/global
 * echoes): every ok/warn/fail branch, the bounded views, the over-budget
 * instruction with the least-read-first paths, the stat-before-read cap
 * (a flagged huge note is never opened), and the ISSUE/INFO split. The
 * engine's seam has no write method; the service-level test below also
 * asserts the service fs recorded zero mutations across an audit call.
 */

const HOME = '/home/test'
const DB = '/data/mem-db'

// ---------------------------------------------------------------------------
// MemAuditFs: read-only in-memory tree with a read ledger.

interface SeedTree {
  dirs?: string[]
  files?: Record<string, string>
  /** Absolute dir path -> writable bit (default true). */
  writable?: Record<string, boolean>
}

class MemAuditFs implements AuditFs, ServiceFs {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly writable = new Map<string, boolean>()
  /** Every readFile target, for flagged-not-read assertions. */
  readonly reads: string[] = []
  /** Mutating ServiceFs calls; stays empty across audit-only work. */
  readonly mutations: string[] = []

  realpath(path: string): string {
    return path
  }

  mkdirp(path: string): void {
    this.mutations.push(`mkdirp ${path}`)
    this.dirs.add(path)
  }

  writeFile(path: string, contents: string): void {
    this.mutations.push(`writeFile ${path}`)
    this.files.set(path, contents)
  }

  rename(from: string, to: string): void {
    this.mutations.push(`rename ${from} -> ${to}`)
    const moved = this.files.get(from)
    this.files.delete(from)
    if (moved !== undefined) {
      this.files.set(to, moved)
    }
  }

  unlink(path: string): void {
    this.mutations.push(`unlink ${path}`)
    this.files.delete(path)
  }

  constructor(seed: SeedTree = {}) {
    for (const dir of seed.dirs ?? []) {
      this.dirs.add(dir)
    }
    for (const [path, contents] of Object.entries(seed.files ?? {})) {
      this.files.set(path, contents)
      this.dirs.add(parentOf(path))
    }
    for (const [dir, bit] of Object.entries(seed.writable ?? {})) {
      this.writable.set(dir, bit)
    }
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  stat(path: string): { sizeBytes: number; mtimeMs: number; directory: boolean; writable: boolean } | null {
    const contents = this.files.get(path)
    if (contents !== undefined) {
      return { sizeBytes: contents.length, mtimeMs: 1700000000000, directory: false, writable: true }
    }
    if (this.dirs.has(path)) {
      return { sizeBytes: 0, mtimeMs: 1700000000000, directory: true, writable: this.writable.get(path) ?? true }
    }
    return null
  }

  readFile(path: string): string | null {
    this.reads.push(path)
    return this.files.get(path) ?? null
  }

  listDirectory(path: string): Array<{ name: string; directory: boolean }> | null {
    if (!this.dirs.has(path)) {
      return null
    }
    const prefix = `${path}/`
    const entries = new Map<string, boolean>()
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
        entries.set(dir.slice(prefix.length), true)
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
        entries.set(file.slice(prefix.length), false)
      }
    }
    return [...entries].map(([name, directory]) => ({ name, directory }))
  }
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

// ---------------------------------------------------------------------------
// Fixtures.

function configFixture(overrides: ObsidianMemConfig = {}) {
  const validated = validateObsidianMemConfig(overrides)
  if (validated.value === undefined) {
    throw new Error(`bad fixture config: ${JSON.stringify(validated.issues)}`)
  }
  return resolveServiceConfig(validated.value, HOME)
}

function statusFixture(over: Partial<ObsidianMemStatus> = {}): ObsidianMemStatus {
  const base: ObsidianMemStatus = {
    state: 'ready',
    milvus: { mode: 'spawn', dbPath: DB, address: '127.0.0.1:19530', version: 'milvus_lite-3.2.2', error: '' },
    indexer: { indexed: 4, pending: 0, errors: 0, llmErrors: 0 },
    budgets: {
      turnStartRecallTokens: 1200,
      globalMemoryTokens: 1500,
      readSections: 2,
      readSectionTokens: 350,
      searchTopK: 6,
      thinkShotsPerTurn: 3,
    },
    dreaming: { schedules: [] },
    notice: null,
  }
  return { ...base, ...over }
}

function globalIndexFixture(over: { budgetTokens?: number, usedTokens?: number, overBudget?: boolean } = {}) {
  const budgetTokens = over.budgetTokens ?? 1500
  const usedTokens = over.usedTokens ?? 0
  return {
    budgetTokens,
    usedTokens,
    remainingTokens: budgetTokens - usedTokens,
    ...(over.overBudget === undefined ? {} : { overBudget: over.overBudget }),
  }
}

function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    index_title: 'Topic: scenario',
    index_description: 'what it decides',
    type: 'global',
    archive: false,
    created: '2026-11-01',
    updated: '2026-11-01',
    read_count: 0,
    ...over,
  }
}

function noteFixture(over: Partial<NoteMeta> = {}): string {
  return serializeNoteWithRaw({ meta: meta(over), body: 'fact body' })
}

function vault(path: string, mode: 'shared' | 'read-only' = 'shared'): VaultEntry {
  return { path, mode, source: 'settings' }
}

/** A healthy shared vault: layout, .INTENTS.md, two notes, state file. */
function healthyVault(path = '/vault/notes'): { dirs: string[], files: Record<string, string> } {
  const files: Record<string, string> = {
    [`${path}/${INTENTS_FILE}`]: renderIntentsFile(),
    [`${path}/alpha.md`]: noteFixture({ index_title: 'Alpha: one', read_count: 5, last_read_at: '2026-11-05' }),
    [`${path}/beta.md`]: noteFixture({ index_title: 'Beta: two', type: 'domain', read_count: 1, last_read_at: '2026-10-01' }),
    [`${path}/.obsidian-mem/metadata/${STATE_FILE_NAME}`]: JSON.stringify({
      version: 2,
      modelId: 'Xenova/multilingual-e5-small',
      vectorDim: 384,
      files: {
        'alpha.md': { contentHash: 'a', mtimeMs: 1, chunkIds: [1, 2] },
        'beta.md': { contentHash: 'b', mtimeMs: 1, chunkIds: [3] },
      },
    }),
  }
  return { dirs: [path, `${path}/.obsidian-mem/metadata`], files }
}

function seedHealthy(): MemAuditFs {
  const seed = healthyVault()
  return new MemAuditFs({ dirs: seed.dirs, files: seed.files })
}

const READY_PROBE = async (): Promise<CollectionProbeResult> => ({
  reachable: true,
  exists: true,
  dim: 384,
  count: 3,
  error: null,
})

interface DepsOptions {
  fs: MemAuditFs
  vaults?: VaultEntry[]
  status?: Partial<ObsidianMemStatus>
  globalIndex?: ReturnType<typeof globalIndexFixture>
  collection?: (() => Promise<CollectionProbeResult>) | null
  config?: ObsidianMemConfig
}

function run(deps: DepsOptions, request = {}) {
  const vaults = deps.vaults ?? [vault('/vault/notes')]
  return runStoreAudit({
    vaults,
    status: statusFixture(deps.status ?? {}),
    // The engine reads plugin state from config.milvus.dbPath; the fixture
    // keeps status and config on the same dbPath.
    config: configFixture({ milvus: { dbPath: DB }, ...(deps.config ?? {}) }),
    globalIndex: deps.globalIndex ?? globalIndexFixture(),
    homedir: HOME,
    fs: deps.fs,
    collection: deps.collection === undefined ? READY_PROBE : deps.collection,
  }, request)
}

function issueIds(report: AuditReport): string[] {
  return report.issues.map((entry) => entry.id)
}

function findIssue(report: AuditReport, id: string) {
  return report.issues.find((entry) => entry.id === id)
}

// ---------------------------------------------------------------------------

describe('runStoreAudit: healthy store', () => {
  it('reports ok with context INFO lines only', async () => {
    const report = await run({ fs: seedHealthy() })
    expect(report.ok).toBe(true)
    expect(issueIds(report).filter((id) => report.issues.find((i) => i.id === id)?.severity === 'ISSUE'))
      .toEqual([])
    expect(issueIds(report)).toContain('index.live')
    expect(issueIds(report)).toContain('dream.last')
    expect(report.stats.noteCount).toBe(2)
    expect(report.stats.sharedVaultCount).toBe(1)
    expect(report.stats.expectedChunks).toBe(3)
    expect(report.rows.map((row) => row.path))
      .toEqual(['/vault/notes/alpha.md', '/vault/notes/beta.md'])
    expect(report.rows[0]?.indexed).toBe(true)
    expect(report.rows[0]?.readCount).toBe(5)
  })

  it('flags the seed-only .INTENTS.md with the nine empty markers', async () => {
    const report = await run({ fs: seedHealthy() })
    const empty = findIssue(report, 'intents.empty')
    expect(empty?.severity).toBe('INFO')
    expect(empty?.detail).toContain('all nine, the file is seed-only')
    for (const marker of INTENT_MARKERS) {
      expect(empty?.detail).toContain(`"${marker}"`)
    }
  })

  it('stops reporting intents as empty once one marker records a line', async () => {
    const fs = seedHealthy()
    fs.files.set(`/vault/notes/${INTENTS_FILE}`, `${renderIntentsFile()}${'- use notes for who decisions\n'}`)
    // The line lands under the last marker (troubleshoot); eight remain empty.
    const report = await run({ fs })
    const empty = findIssue(report, 'intents.empty')
    expect(empty?.detail).not.toContain('troubleshoot')
    expect(empty?.detail).not.toContain('all nine')
    expect(empty?.detail).toContain('"who"')
  })

  it('reports the budget echo as unmeasured while the tracker is inactive', async () => {
    const report = await run({ fs: seedHealthy() })
    const budget = findIssue(report, 'budget.tracker')
    expect(budget?.detail).toContain('no recall budget spent in this process yet')
    expect(report.budget.measured).toBe(false)
    expect(report.budget.overBudget).toBe(false)
  })
})

describe('runStoreAudit: vault problems', () => {
  it('reports a missing vault as an ISSUE', async () => {
    const report = await run({ fs: new MemAuditFs(), vaults: [vault('/vault/gone')] })
    expect(report.ok).toBe(false)
    expect(findIssue(report, 'vault.missing')?.severity).toBe('ISSUE')
    expect(findIssue(report, 'vault.missing')?.remediation).toContain('restart')
  })

  it('reports a vault root that is not a directory as ISSUE and a missing sidecar dir as INFO', async () => {
    // In the new layout the vault root IS the note root, so the
    // rootIsDirectory failure shape is a root that is a plain file.
    const fs = new MemAuditFs({ files: { '/vault/notes': 'not a directory' } })
    const report = await run({ fs })
    expect(findIssue(report, 'vault.root-not-directory')?.severity).toBe('ISSUE')
    expect(findIssue(report, 'vault.sidecar-missing')?.severity).toBe('INFO')
    expect(findIssue(report, 'intents.missing')?.severity).toBe('ISSUE')
  })

  it('reports a shared vault that is not writable and a read-only vault that is', async () => {
    const seed = healthyVault('/vault/shared')
    const other = healthyVault('/vault/ro')
    const fs = new MemAuditFs({
      dirs: [...seed.dirs, ...other.dirs],
      files: { ...seed.files, ...other.files },
      writable: { '/vault/shared': false, '/vault/ro': true },
    })
    const report = await run({ fs, vaults: [vault('/vault/shared'), vault('/vault/ro', 'read-only')] })
    expect(findIssue(report, 'vault.writable')?.severity).toBe('ISSUE')
    expect(findIssue(report, 'vault.writable')?.remediation).toContain('read-only')
    expect(findIssue(report, 'vault.readonly-writable')?.severity).toBe('INFO')
  })

  it('announces the pending default vault when no shared vault exists, without creating it', async () => {
    const fs = new MemAuditFs()
    const report = await run({ fs, vaults: [] })
    const pending = findIssue(report, 'vaults.default-pending')
    expect(pending?.detail).toContain(defaultVaultPath(HOME))
    expect(pending?.detail).toContain('will be created')
    expect(report.ok).toBe(true)
    expect(fs.reads.some((path) => path.includes('obsidian-mem'))).toBe(false)
  })

  it('restates the default-vault notice when one is in use', async () => {
    const notice = 'Obsidian Mem is using the default memory vault at /home/test/.dsh/obsidian-mem. Add your own vaults in the Obsidian Mem settings card to override it.'
    const report = await run({ fs: seedHealthy(), status: { notice } })
    const echo = findIssue(report, 'vaults.default-in-use')
    expect(echo?.severity).toBe('INFO')
    expect(echo?.detail).toContain('default memory vault')
  })
})

describe('runStoreAudit: index pipeline', () => {
  it('degraded reports an ISSUE with the error echoed quoted', async () => {
    const report = await run({ fs: seedHealthy(), status: { state: 'degraded', milvus: { mode: 'spawn', dbPath: DB, address: '', version: '', error: 'uvx exited with 1' } }, collection: null })
    const degraded = findIssue(report, 'index.degraded')
    expect(degraded?.severity).toBe('ISSUE')
    expect(degraded?.detail).toContain('"uvx exited with 1"')
    expect(issueIds(report)).not.toContain('collection.dim-drift')
  })

  it('cold reports INFO and never contacts the probe', async () => {
    let probeCalls = 0
    const report = await run({
      fs: seedHealthy(),
      status: { state: 'inactive', indexer: null, milvus: { mode: 'spawn', dbPath: DB, address: '', version: '', error: '' } },
      collection: async () => {
        probeCalls += 1
        return { reachable: true, exists: true, dim: 384, count: 0, error: null }
      },
    })
    expect(findIssue(report, 'index.cold')?.severity).toBe('INFO')
    expect(probeCalls).toBe(0)
    expect(report.stats.indexer).toBeNull()
    expect(report.stats.collectionCount).toBeNull()
  })

  it('surfaces dim drift, a missing collection, an unreachable probe, and count drift', async () => {
    const dimDrift = await run({
      fs: seedHealthy(),
      collection: async () => ({ reachable: true, exists: true, dim: 256, count: 3, error: null }),
    })
    expect(findIssue(dimDrift, 'collection.dim-drift')?.detail).toContain('256-d')

    const missing = await run({
      fs: seedHealthy(),
      collection: async () => ({ reachable: true, exists: false, dim: null, count: null, error: null }),
    })
    expect(findIssue(missing, 'collection.missing')?.severity).toBe('ISSUE')

    const unreachable = await run({
      fs: seedHealthy(),
      collection: async () => ({ reachable: false, exists: false, dim: null, count: null, error: 'connection refused' }),
    })
    expect(findIssue(unreachable, 'index.probe')?.detail).toContain('"connection refused"')

    const drift = await run({
      fs: seedHealthy(),
      collection: async () => ({ reachable: true, exists: true, dim: 384, count: 9, error: null }),
    })
    expect(findIssue(drift, 'index.count-drift')?.severity).toBe('INFO')
    expect(findIssue(drift, 'index.count-drift')?.detail).toContain('drift 6')
  })

  it('maps indexer progress counts to severities', async () => {
    const report = await run({
      fs: seedHealthy(),
      status: { indexer: { indexed: 10, pending: 2, errors: 1, llmErrors: 3 } },
    })
    expect(findIssue(report, 'indexer.errors')?.severity).toBe('ISSUE')
    expect(findIssue(report, 'indexer.llm-errors')?.severity).toBe('INFO')
    expect(findIssue(report, 'indexer.pending')?.severity).toBe('INFO')
    expect(report.stats.indexer).toEqual({ indexed: 10, pending: 2, errors: 1, llmErrors: 3 })
  })

  it('reads the per-vault state file: missing, corrupt, and stale builds', async () => {
    const noState = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: { '/v/a.md': noteFixture() },
    })
    expect(findIssue(await run({ fs: noState, vaults: [vault('/v')] }), 'state.missing')?.severity).toBe('INFO')

    const corrupt = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: {
        '/v/a.md': noteFixture(),
        [`/v/.obsidian-mem/metadata/${STATE_FILE_NAME}`]: '{ broken',
      },
    })
    expect(findIssue(await run({ fs: corrupt, vaults: [vault('/v')] }), 'state.unreadable')?.severity).toBe('ISSUE')

    const stale = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: {
        '/v/a.md': noteFixture(),
        [`/v/.obsidian-mem/metadata/${STATE_FILE_NAME}`]: JSON.stringify({ version: 2, modelId: 'other/model', vectorDim: 256, files: {} }),
      },
    })
    const report = await run({ fs: stale, vaults: [vault('/v')] })
    expect(findIssue(report, 'state.stale-model')?.severity).toBe('ISSUE')
    expect(findIssue(report, 'state.stale-dim')?.severity).toBe('ISSUE')
  })

  it('flags misplaced reserved protocol files, a root DREAMS.md included', async () => {
    // The sidecar home of DREAMS.md is dot-hidden, so any reachable copy is
    // misplaced, the pre-migration root copy included; other reserved names
    // are only misplaced below the root.
    const fs = new MemAuditFs({
      dirs: ['/v', '/v/deep', '/v/.obsidian-mem/metadata'],
      files: {
        '/v/DREAMS.md': '# diary at the wrong place',
        '/v/deep/a_history.md': '# history in the wrong place',
        '/v/a.md': noteFixture(),
      },
    })
    const report = await run({ fs, vaults: [vault('/v')] })
    const misplaced = findIssue(report, 'reserved.placement')
    expect(misplaced?.severity).toBe('ISSUE')
    expect(misplaced?.detail).toContain('/v/DREAMS.md')
    expect(misplaced?.detail).toContain('/v/deep/a_history.md')
    expect(misplaced?.remediation).toContain('move it to <vault>/.obsidian-mem/metadata/')
  })
})

describe('runStoreAudit: note bloat classes', () => {
  it('flags a huge note WITHOUT reading it', async () => {
    const huge = `${'x'.repeat(4 * 1024 * 1024 + 16)}`
    const fs = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: { '/v/planted.md': huge, '/v/a.md': noteFixture() },
    })
    const report = await run({ fs, vaults: [vault('/v')] })
    const flagged = findIssue(report, 'notes.huge-not-read')
    expect(flagged?.severity).toBe('INFO')
    expect(flagged?.detail).toContain('planted.md')
    expect(fs.reads).not.toContain('/v/planted.md')
    expect(report.stats.hugeNotReadNotes).toEqual(['/v/planted.md'])
    const row = report.rows.find((entry) => entry.path === '/v/planted.md')
    expect(row?.flaggedNotRead).toBe(true)
    expect(row?.sizeBytes).toBeGreaterThan(4 * 1024 * 1024)
  })

  it('reports oversized notes as the timeline INFO with the _history remediation', async () => {
    const fat = noteFixture({ index_title: 'Timeline: pr by pr' }) + 'y'.repeat(12 * 1024)
    const fs = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: { '/v/timeline.md': fat },
    })
    const report = await run({ fs, vaults: [vault('/v')] })
    const oversized = findIssue(report, 'notes.oversized')
    expect(oversized?.severity).toBe('INFO')
    expect(oversized?.remediation).toContain('_history.md')
    expect(report.rows[0]?.oversized).toBe(true)
  })

  it('reports malformed frontmatter as an ISSUE with the parse error echoed quoted', async () => {
    const fs = new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata'],
      files: { '/v/bad.md': '---\nfoo: [unclosed\nbar: "unterminated\n---\nbody\n' },
    })
    const report = await run({ fs, vaults: [vault('/v')] })
    const malformed = findIssue(report, 'notes.malformed')
    expect(malformed?.severity).toBe('ISSUE')
    expect(malformed?.detail).toContain('bad.md')
  })
})

describe('runStoreAudit: model cache and dreaming lines', () => {
  it('reports an uncached embedding model', async () => {
    const report = await run({ fs: seedHealthy() })
    expect(findIssue(report, 'model.uncached')?.detail).toContain(modelCacheDir(HOME))
  })

  it('stays quiet about the model once the cache dir has content', async () => {
    const seed = healthyVault()
    const fs = new MemAuditFs({
      dirs: [...seed.dirs, modelCacheDir(HOME)],
      files: { ...seed.files, [`${modelCacheDir(HOME)}/model.onnx`]: 'ONNX' },
    })
    const report = await run({ fs })
    expect(issueIds(report)).not.toContain('model.uncached')
  })

  it('echoes the last dream stamp and the dreaming schedules', async () => {
    const fs = seedHealthy()
    fs.files.set(`${DB}/state/state.json`, JSON.stringify({ lastDreamAt: 1730000000000 }))
    const report = await run({
      fs,
      status: { dreaming: { schedules: [{ id: 'nightly', label: 'Nightly compact', expression: '0 3 * * *' }] } },
    })
    expect(report.stats.lastDreamAt).toBe(1730000000000)
    expect(findIssue(report, 'dream.last')?.detail).toContain('2024-10-27')
    expect(findIssue(report, 'dreaming.schedules')?.detail).toContain('Nightly compact')
  })
})

describe('runStoreAudit: global budget section', () => {
  function budgetFs(): MemAuditFs {
    return new MemAuditFs({
      dirs: ['/v', '/v/.obsidian-mem/metadata', modelCacheDir(HOME)],
      files: {
        '/v/unread.md': noteFixture({ index_title: 'Unread: global', type: 'global' }),
        '/v/read-once.md': noteFixture({ index_title: 'Once: global', type: 'global', read_count: 1, last_read_at: '2026-10-01' }),
        '/v/popular.md': noteFixture({ index_title: 'Popular: global', type: 'global', read_count: 9, last_read_at: '2026-11-10' }),
        '/v/domain-note.md': noteFixture({ index_title: 'Domain: not global', type: 'domain' }),
        '/v/archived-global.md': noteFixture({ index_title: 'Archived: global', type: 'global', archive: true }),
      },
    })
  }

  it('lists live global notes least-read first, excluding archived and non-global', async () => {
    const report = await run({ fs: budgetFs(), collection: null, vaults: [vault('/v')] })
    expect(report.budget.globalNotePaths).toEqual([
      '/v/unread.md',
      '/v/read-once.md',
      '/v/popular.md',
    ])
    expect(report.budget.globalNoteCount).toBe(3)
  })

  it('over budget: reports an ISSUE instructing memory_dream over the least-read-first list', async () => {
    const report = await run({ fs: budgetFs(), globalIndex: globalIndexFixture({ usedTokens: 2000 }), vaults: [vault('/v')] })
    const over = findIssue(report, 'budget.over')
    expect(over?.severity).toBe('ISSUE')
    expect(over?.remediation).toContain('run memory_dream to process and compact all global memory markdown files, least-read first')
    const remediation = over?.remediation ?? ''
    expect(remediation.indexOf('unread.md')).toBeLessThan(remediation.indexOf('popular.md'))
    expect(issueIds(report)).not.toContain('budget.tracker')
    expect(report.ok).toBe(false)
  })

  it('honors the tracker overBudget echo even at zero used tokens', async () => {
    const report = await run({ fs: budgetFs(), globalIndex: globalIndexFixture({ usedTokens: 0, overBudget: true }), vaults: [vault('/v')] })
    expect(report.budget.measured).toBe(true)
    expect(report.budget.overBudget).toBe(true)
    expect(issueIds(report)).toContain('budget.over')
  })
})

describe('runStoreAudit: bounded views', () => {
  function viewFs(): MemAuditFs {
    const old = (readCount: number, last: string | undefined, title: string) => {
      const over: Partial<NoteMeta> = { index_title: title, type: 'domain', read_count: readCount }
      if (last !== undefined) {
        over.last_read_at = last
      }
      return noteFixture(over)
    }
    const files: Record<string, string> = {
      '/v/never.md': old(0, undefined, 'Never: read'),
      '/v/stale.md': old(1, '2026-01-01', 'Stale: read'),
      '/v/fresh.md': old(7, '2026-11-09', 'Fresh: read'),
      '/v/archived.md': old(0, undefined, 'Archived: note'),
      '/v/old-unread.md': old(0, undefined, 'Old: unread'),
    }
    files['/v/archived.md'] = serializeNoteWithRaw({
      meta: meta({ index_title: 'Archived: note', type: 'domain', archive: true }),
      body: 'gone',
    })
    return new MemAuditFs({ dirs: ['/v', '/v/.obsidian-mem/metadata'], files })
  }

  it('full lists every note by path and bounds rows by limit', async () => {
    const report = await run({ fs: viewFs(), collection: null, vaults: [vault('/v')] }, { limit: 2 })
    expect(report.rows.length).toBe(2)
    expect(report.totalRows).toBe(5)
    expect(report.rows[0]?.path).toBe('/v/archived.md')
    expect(report.view).toBe('full')
    expect(report.limit).toBe(2)
  })

  it('topStale ranks never-read before stale before fresh and drops archived', async () => {
    const report = await run({ fs: viewFs(), collection: null, vaults: [vault('/v')] }, { view: 'topStale' })
    expect(report.rows.map((row) => row.path)).toEqual([
      '/v/never.md',
      '/v/old-unread.md',
      '/v/stale.md',
      '/v/fresh.md',
    ])
  })

  it('oldestUnread keeps only unread live notes, oldest on disk first', async () => {
    const fs = viewFs()
    // Give old-unread.md the older mtime by seeding it into an older dir map.
    const report = await run({ fs, collection: null, vaults: [vault('/v')] }, { view: 'oldestUnread' })
    expect(report.rows.map((row) => row.path)).toEqual(['/v/never.md', '/v/old-unread.md'])
  })
})

describe('runStoreAudit: rollups and walk', () => {
  it('counts usage bytes across the vault tree excluding dot dirs', async () => {
    const seed = healthyVault()
    const fs = new MemAuditFs({ dirs: seed.dirs, files: seed.files })
    const report = await run({ fs, collection: null })
    const notesBytes = Object.entries(seed.files)
      .filter(([path]) => !path.includes('.obsidian-mem') && !path.includes(INTENTS_FILE))
      .reduce((sum, [, contents]) => sum + contents.length, 0)
    expect(report.stats.totalBytes).toBe(notesBytes)
    expect(report.stats.vaultUsage).toEqual([{ vault: '/vault/notes', notes: 2, bytes: notesBytes }])
  })
})

describe('inventoryVault + seam shape', () => {
  it('the audit fs seam exposes no write method at all', () => {
    expect(Object.keys(nodeAuditFs).sort()).toEqual(['exists', 'listDirectory', 'readFile', 'stat'])
  })

  it('a vault entry that is not a directory yields the empty inventory', () => {
    const fs = new MemAuditFs({ files: { '/not-a-dir': 'x' } })
    const inventory = inventoryVault(vault('/not-a-dir'), fs)
    expect(inventory.facts.exists).toBe(true)
    expect(inventory.facts.rootIsDirectory).toBe(false)
    expect(inventory.facts.sidecarPresent).toBe(false)
    expect(inventory.notes).toEqual([])
  })
})

// ---------------------------------------------------------------------------

function fakeCtx() {
  const ctx = {
    reflect: {
      provide: () => () => {},
    },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    effect: (execute: () => () => void) => {
      const dispose = execute()
      return () => {
        dispose()
      }
    },
    get: () => undefined,
  }
  return ctx as unknown as Context
}

describe('ObsidianMemService.audit(): doctor, not accessor', () => {
  it('never provisions and mutates nothing on a never-touched service', async () => {
    const seed = healthyVault()
    const fs = new MemAuditFs({ dirs: seed.dirs, files: seed.files })
    const service = new ObsidianMemService(
      fakeCtx(),
      { vaults: [{ path: '/vault/notes', mode: 'shared' }], milvus: { dbPath: DB } },
      { homedir: () => HOME, fs, auditFs: fs },
    )
    const report = await service.audit()
    expect(fs.mutations).toEqual([])
    expect(report.stats.vaultCount).toBe(1)
    expect(report.stats.noteCount).toBe(2)
    // Never provisioned: index cold (INFO), collection never contacted.
    expect(issueIds(report)).toContain('index.cold')
    expect(report.stats.collectionCount).toBeNull()
    // ensureMemoryAccess side effects (default vault, intents seed, dbDir)
    // would all show up as mutations; none happened.
    expect(fs.exists(defaultVaultPath(HOME))).toBe(false)
  })
})
