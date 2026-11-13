/**
 * DreamOrchestrator spec (TASK-035 DoD): candidate ranking with faked
 * vectors and stats, the golden work-plan text, prompt seed-once with
 * render-on-load tunables, the single-flight guard armed before the first
 * await, the ext launch sequence (session dream-<uuid> with resolved
 * provider/model AgentOptions, followup, whenIdle, dispose), the
 * provider/model precedence and blocked resolution (dream-launch
 * TASK-001), the host agentDefaultModel route (TASK-002), failed-turn
 * detection from the session log (TASK-003), the load-bearing scoring
 * order (relevancy scored against the PREVIOUS stamp, THEN lastDreamAt
 * written), and the ok-path onRunSucceeded dep firing exactly once
 * (PLAN-budget-rebaseline TASK-002). Everything external is a fake:
 * ServiceFs in memory, inventories as data, a fake agents gateway (whose
 * agent double answers ownEvents with a scripted transcript), a fake host
 * default-model route, faked vectors.
 */

import { describe, expect, it } from 'vitest'

import { GLOBAL_MEMORY_FILE_DEFAULT, NOTE_TIMELINE_BYTES } from '../../core/lib/index.js'
import type { NoteMeta } from '../../core/lib/index.js'
import { DEFAULT_DREAM_PROMPT, DreamBlockedError, DreamBusyError, DreamOrchestrator, renderPromptTunables } from '../src/dream.ts'
import type { DreamAgentsGateway, DreamDeps, DreamVectorTarget } from '../src/dream.ts'
import { failedTurnError, fakeGateway, turnEndRecord } from './dream-testkit.ts'
import type { AuditedNote, VaultInventory } from '../src/audit.ts'
import type { ResolvedObsidianMemConfig } from '../src/config.ts'
import type { ServiceFs } from '../src/service.ts'

const DB = '/data/mem-db'
const SHARED = '/vault/shared'
const READ_ONLY = '/vault/ro'
const LAST_DREAM_ISO = '2026-06-01T12:00:00Z'

// ---------------------------------------------------------------------------
// In-memory ServiceFs with a mutation ledger.

class MemFs implements ServiceFs {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly mutations: string[] = []

  constructor(seed: { dirs?: string[]; files?: Record<string, string> } = {}) {
    for (const dir of seed.dirs ?? []) {
      this.dirs.add(dir)
    }
    for (const [path, contents] of Object.entries(seed.files ?? {})) {
      this.files.set(path, contents)
    }
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  realpath(path: string): string {
    return path
  }

  mkdirp(path: string): void {
    this.mutations.push(`mkdirp ${path}`)
    this.dirs.add(path)
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null
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

  stat(path: string): { mtimeMs: number } | null {
    return this.exists(path) ? { mtimeMs: 0 } : null
  }
}

// ---------------------------------------------------------------------------
// Fixtures.

function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    index_title: 'Topic: scenario',
    index_description: 'what this note decides',
    type: 'global',
    archive: false,
    created: '2026-01-01',
    updated: '2026-01-01',
    read_count: 0,
    ...over,
  }
}

function note(
  vaultPath: string,
  name: string,
  over: { meta?: Partial<NoteMeta>; sizeBytes?: number } = {},
): AuditedNote {
  const rel = `${name}.md`
  return {
    path: `${vaultPath}/${rel}`,
    vaultPath,
    rel,
    sizeBytes: over.sizeBytes ?? 2048,
    mtimeMs: 1_700_000_000_000,
    flaggedNotRead: false,
    malformed: null,
    meta: meta({ index_title: `${name}: scenario`, ...over.meta }),
    indexed: true,
  }
}

function brokenNote(vaultPath: string, name: string): AuditedNote {
  return { ...note(vaultPath, name), meta: null, malformed: '"bad frontmatter"' }
}

function inventory(vaultPath: string, mode: 'shared' | 'read-only', notes: AuditedNote[], globalFile: string = GLOBAL_MEMORY_FILE_DEFAULT): VaultInventory {
  return {
    vault: { path: vaultPath, mode, globalFile, source: 'settings' },
    facts: { exists: true, rootIsDirectory: true, sidecarPresent: true, writable: mode === 'shared' },
    notes,
    reservedMisplaced: [],
    walkTruncated: false,
    usageBytes: notes.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    state: { path: `${vaultPath}/.obsidian-mem/metadata/state.json`, present: true, parseError: null, modelId: 'm', vectorDim: 384, fileCount: notes.length, expectedChunks: notes.length, fileKeys: notes.map((entry) => entry.rel) },
  }
}

function configFixture(overrides: Partial<ResolvedObsidianMemConfig> = {}): ResolvedObsidianMemConfig {
  return {
    vaults: [],
    vectorDim: 384,
    model: { id: 'model', dtype: 'q8' },
    milvus: { mode: 'spawn', address: '', dbPath: DB, readinessTimeoutMs: 1 },
    budgets: {
      turnStartRecallTokens: 500,
      globalMemoryTokens: 1500,
      readSections: 4,
      readSectionTokens: 350,
      searchTopK: 6,
      thinkShotsPerTurn: 3,
    },
    llm: { enabled: false, baseUrl: '', model: '', apiKeyEnv: '' },
    dreaming: { schedules: [], model: '', nearDuplicateThreshold: 0.92 },
    ...overrides,
  }
}

function stampedFs(files: Record<string, string> = {}): MemFs {
  return new MemFs({
    files: { [`${DB}/state/state.json`]: JSON.stringify({ lastDreamAt: Date.parse(LAST_DREAM_ISO) }), ...files },
  })
}

interface DepsOptions {
  fs?: MemFs
  inventories?: VaultInventory[]
  config?: ResolvedObsidianMemConfig
  globalIndex?: { budgetTokens: number; usedTokens: number; remainingTokens: number; overBudget?: boolean }
  gateway?: DreamAgentsGateway | null
  defaultAgentOptions?: () => { provider?: string; model?: string } | undefined
  vectors?: (targets: readonly DreamVectorTarget[]) => Promise<Map<string, number[]>>
  onRunSucceeded?: () => void
  logs?: string[]
}

function deps(fixture: DepsOptions): DreamDeps {
  return {
    fs: fixture.fs ?? new MemFs(),
    config: fixture.config ?? configFixture(),
    inventories: () => fixture.inventories ?? [],
    // GlobalMemoryIndex requires overBudget under exactOptionalPropertyTypes;
    // supply the production default (used > budget) when the fixture omits it.
    globalIndex: () => {
      const globalIndex = fixture.globalIndex ?? { budgetTokens: 1500, usedTokens: 0, remainingTokens: 1500 }
      return { ...globalIndex, overBudget: globalIndex.overBudget ?? globalIndex.usedTokens > globalIndex.budgetTokens }
    },
    agentsGateway: () => fixture.gateway ?? undefined,
    defaultAgentOptions: fixture.defaultAgentOptions ?? (() => ({ provider: 'acme', model: 'm-1' })),
    noteVectors: fixture.vectors ?? (async () => new Map<string, number[]>()),
    onRunSucceeded: fixture.onRunSucceeded ?? (() => {}),
    log: (message) => {
      ;(fixture.logs ?? []).push(message)
    },
  }
}

// ---------------------------------------------------------------------------

describe('plan: candidate ranking', () => {
  it('ranks weighted reasons, skips archived and unparseable, and flags read-only vaults', async () => {
    const shared = inventory(SHARED, 'shared', [
      note(SHARED, 'never-read'),
      note(SHARED, 'hot', { meta: { read_count: 9, last_read_at: '2026-11-10' } }),
      note(SHARED, 'huge-timeline', { meta: { read_count: 2, last_read_at: '2026-11-09' }, sizeBytes: NOTE_TIMELINE_BYTES + 1 }),
      note(SHARED, 'archived', { meta: { archive: true, read_count: 4 } }),
      brokenNote(SHARED, 'broken'),
    ])
    const readOnly = inventory(READ_ONLY, 'read-only', [note(READ_ONLY, 'ro-never-read')])
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [shared, readOnly],
      globalIndex: { budgetTokens: 1500, usedTokens: 2000, remainingTokens: -500 },
    }))
    const plan = await orchestrator.plan()
    const names = plan.candidates.map((candidate) => candidate.path.split('/').pop())
    // weights: oversized 3 + global-budget 4 > never-read 2 + global-budget 4
    // (path tie-break puts /vault/ro first) > global-budget alone.
    expect(names).toEqual(['huge-timeline.md', 'ro-never-read.md', 'never-read.md', 'hot.md'])
    expect(plan.candidates.some((candidate) => candidate.path.endsWith('archived.md'))).toBe(false)
    expect(plan.candidates.some((candidate) => candidate.path.endsWith('broken.md'))).toBe(false)
    const neverRead = plan.candidates[1]
    expect(neverRead?.mode).toBe('read-only')
    expect(neverRead?.reasons).toEqual(['never-read', 'global-over-budget'])
    expect(plan.candidates[0]?.reasons).toEqual(['oversized-timeline', 'global-over-budget'])
    expect(plan.stats.oversized).toBe(1)
    expect(plan.stats.staleOrUnread).toBe(2)
    expect(plan.budget.overBudget).toBe(true)
    // least-read first, path tie-break.
    expect(plan.budget.globalNotePaths).toEqual([
      `${READ_ONLY}/ro-never-read.md`,
      `${SHARED}/never-read.md`,
      `${SHARED}/huge-timeline.md`,
      `${SHARED}/hot.md`,
    ])
    expect(plan.plan).toContain('read-only: raise the review with the user instead of editing')
  })

  it('does not rank previously-read notes until a dream stamp exists', async () => {
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [inventory(SHARED, 'shared', [
        note(SHARED, 'read-long-ago', { meta: { type: 'domain', read_count: 1, last_read_at: '2026-01-05' } }),
      ])],
    }))
    const plan = await orchestrator.plan()
    expect(plan.candidates).toEqual([])
    expect(plan.plan).toBe('No candidates found: the store needs no compaction work this run.')
  })

  it('ranks unread-since-last-dream once a dream stamp exists', async () => {
    const orchestrator = new DreamOrchestrator(deps({
      fs: stampedFs(),
      inventories: [inventory(SHARED, 'shared', [
        note(SHARED, 'stale', { meta: { type: 'domain', read_count: 3, last_read_at: '2026-03-01' } }),
        note(SHARED, 'fresh', { meta: { type: 'domain', read_count: 1, last_read_at: '2026-11-01' } }),
      ])],
    }))
    const plan = await orchestrator.plan()
    expect(plan.candidates.map((candidate) => candidate.path.split('/').pop())).toEqual(['stale.md'])
    expect(plan.candidates[0]?.reasons).toEqual(['unread-since-last-dream'])
    expect(plan.lastDreamAt).toBe(Date.parse(LAST_DREAM_ISO))
  })

  it('clusters near-duplicates over faked vectors and leaves singletons out', async () => {
    const target = (name: string): string => `${SHARED}/${name}.md`
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [inventory(SHARED, 'shared', [
        note(SHARED, 'a'),
        note(SHARED, 'b'),
        note(SHARED, 'c'),
      ])],
      vectors: async () => new Map<string, number[]>([
        [target('a'), [0.98, 0.02]],
        [target('b'), [0.97, 0.03]],
        [target('c'), [0.10, 0.90]],
      ]),
    }))
    const plan = await orchestrator.plan()
    expect(plan.clusters).toEqual([[target('a'), target('b')]])
    expect(plan.skipped).toEqual([])
    expect(plan.plan).toContain(`Merge near-duplicate: memory_read ${target('a')} and ${target('b')}`)
    expect(plan.plan).toContain(`memory_write ${target('b')} with archive=true`)
    // clustered notes get merge actions, not duplicate review lines.
    expect(plan.plan).toContain(`Review (never-read): ${target('c')}`)
    expect(plan.plan).not.toContain(`Review (never-read): ${target('a')}`)
  })

  it('skips the near-duplicate check honestly when vectors answer empty', async () => {
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [inventory(SHARED, 'shared', [note(SHARED, 'a')])],
    }))
    const plan = await orchestrator.plan()
    expect(plan.clusters).toEqual([])
    expect(plan.skipped).toEqual([
      'near-duplicate analysis (no stored vectors available: the vector index is cold or the candidates are unindexed)',
    ])
    expect(plan.plan).toContain('Skipped check')
  })

  // TASK-015: a vault's own globalFile note is never a candidate, so it
  // enters no cluster and no work line, while still counting in the budget.
  it('never ranks or clusters a vault globalFile, and protection is per vault', async () => {
    const a = `${SHARED}/a.md`
    const b = `${SHARED}/b.md`
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [
        inventory(SHARED, 'shared', [
          // Never-read + oversized + global-over-budget: every reason, still skipped.
          note(SHARED, 'GLOBAL', { sizeBytes: NOTE_TIMELINE_BYTES + 1 }),
          note(SHARED, 'a'),
          note(SHARED, 'b'),
        ]),
        // Vault B names a different global file: its GLOBAL.md stays an ordinary note.
        inventory(READ_ONLY, 'read-only', [note(READ_ONLY, 'GLOBAL')], 'notes/MAIN.md'),
      ],
      globalIndex: { budgetTokens: 1500, usedTokens: 2000, remainingTokens: -500 },
      vectors: async () => new Map<string, number[]>([
        [`${SHARED}/GLOBAL.md`, [1, 0]],
        [a, [0.99, 0.01]],
        [b, [0.98, 0.02]],
      ]),
    }))
    const plan = await orchestrator.plan()
    const candidatePaths = plan.candidates.map((candidate) => candidate.path)
    expect(candidatePaths).not.toContain(`${SHARED}/GLOBAL.md`)
    expect(candidatePaths).toContain(`${READ_ONLY}/GLOBAL.md`)
    // The protected copy carries a near-duplicate vector and still never clusters.
    expect(plan.clusters).toEqual([[a, b]])
    // Budget math honesty: the protected note counts, it just never works.
    expect(plan.budget.globalNoteCount).toBe(4)
    expect(plan.budget.globalNotePaths).toEqual([`${READ_ONLY}/GLOBAL.md`, `${SHARED}/GLOBAL.md`, a, b])
    expect(plan.budget.compactableGlobalNotePaths).toEqual([`${READ_ONLY}/GLOBAL.md`, a, b])
    expect(plan.plan).not.toContain(`${SHARED}/GLOBAL.md`)
  })

  it('answers the cannot-help work plan when every live global note is protected', async () => {
    const orchestrator = new DreamOrchestrator(deps({
      inventories: [inventory(SHARED, 'shared', [
        note(SHARED, 'GLOBAL'),
        note(SHARED, 'domain-note', { meta: { type: 'domain', read_count: 1, last_read_at: '2026-11-09' } }),
      ])],
      globalIndex: { budgetTokens: 1500, usedTokens: 1800, remainingTokens: -300 },
    }))
    const plan = await orchestrator.plan()
    expect(plan.budget.globalNoteCount).toBe(1)
    expect(plan.budget.compactableGlobalNotePaths).toEqual([])
    expect(plan.plan).toBe([
      '1. Global memory is over budget (1800 of 1500 tokens used), and every live global note is a vault global file the dreaming pass never compacts: compaction cannot help; manually tighten /vault/shared/GLOBAL.md to reclaim budget.',
      '2. Skipped check: near-duplicate analysis (no candidates to compare).',
    ].join('\n'))
  })

  it('answers the golden work plan text for a small over-budget store', async () => {
    const orchestrator = new DreamOrchestrator(deps({
      fs: stampedFs(),
      inventories: [inventory(SHARED, 'shared', [
        note(SHARED, 'stale-global', { meta: { read_count: 1, last_read_at: '2026-03-01' } }),
        note(SHARED, 'timeline', { meta: { type: 'domain', read_count: 2, last_read_at: '2026-11-09' }, sizeBytes: NOTE_TIMELINE_BYTES + 1 }),
      ])],
      globalIndex: { budgetTokens: 1500, usedTokens: 1800, remainingTokens: -300 },
    }))
    const plan = await orchestrator.plan()
    expect(plan.plan).toBe([
      '1. Split timeline /vault/shared/timeline.md: keep the conclusion in it and move the history into a /vault/shared/timeline_history.md note at the vault root (reserved, never indexed).',
      '2. Compact global note /vault/shared/stale-global.md: it injects into every session; tighten it to a conclusion pointer.',
      '3. Review (unread-since-last-dream, global-over-budget): /vault/shared/stale-global.md: verify it with memory_read; correct it or set archive=true when it no longer holds.',
      '4. Global memory is over budget (1800 of 1500 tokens used). 1 live global notes inject; compact least-read first: /vault/shared/stale-global.md.',
      '5. Skipped check: near-duplicate analysis (no stored vectors available: the vector index is cold or the candidates are unindexed).',
    ].join('\n'))
  })
})

describe('prompt: seed once, render tunables on every load', () => {
  it('seeds the default prompt file once and renders tunables from config', () => {
    const fs = new MemFs()
    const orchestrator = new DreamOrchestrator(deps({ fs }))
    const first = orchestrator.loadPrompt()
    expect(fs.files.get(`${DB}/dream-prompt.md`)).toBe(DEFAULT_DREAM_PROMPT)
    expect(first).toContain('12288')
    expect(first).toContain('1500')
    expect(first).toContain('0.92')
    expect(first).toContain('_history.md')
    // The seeded protocol names the sidecar diary location, not a vault-root
    // DREAMS.md (PLAN-vault-layout TASK-006).
    expect(first).toContain('DREAMS.md in the first shared vault\'s .obsidian-mem/metadata/')
    expect(first).not.toContain('at the first shared vault root')
    expect(first).not.toContain('{{')
    expect(fs.mutations).toEqual([`mkdirp ${DB}`, `writeFile ${DB}/dream-prompt.md`])
    // Second load: no re-seed, same render.
    expect(orchestrator.loadPrompt()).toBe(first)
    expect(fs.mutations).toHaveLength(2)
  })

  it('keeps user edits and re-renders tunables from changed config', () => {
    const fs = new MemFs({ dirs: [DB], files: { [`${DB}/dream-prompt.md`]: 'Split notes above {{NOTE_TIMELINE_BYTES}} bytes; budget {{GLOBAL_MEMORY_TOKENS}}.' } })
    const orchestrator = new DreamOrchestrator(deps({ fs }))
    expect(orchestrator.loadPrompt()).toBe('Split notes above 12288 bytes; budget 1500.')
    // A config change is picked up next load without touching the file.
    const other = new DreamOrchestrator(deps({
      fs,
      config: configFixture({ budgets: { ...configFixture().budgets, globalMemoryTokens: 900 } }),
    }))
    expect(other.loadPrompt()).toBe('Split notes above 12288 bytes; budget 900.')
    expect(fs.mutations).toEqual([])
    expect(renderPromptTunables('unknown {{PLACEHOLDER}} stays', configFixture())).toBe('unknown {{PLACEHOLDER}} stays')
  })
})

describe('run: single flight and the launch sequence', () => {
  it('arms the guard synchronously: the second concurrent run throws immediately', async () => {
    // Order-independent gate: whenIdle resolves immediately once opened,
    // otherwise its resolver waits, wherever the run is in its awaits.
    let opened = false
    const resolvers: Array<() => void> = []
    const recorder = fakeGateway({
      whenIdle: () => (opened ? Promise.resolve() : new Promise<void>((resolve) => { resolvers.push(resolve) })),
    })
    const settle = (): void => {
      opened = true
      resolvers.splice(0).forEach((resolve) => {
        resolve()
      })
    }
    const orchestrator = new DreamOrchestrator(deps({ gateway: recorder.gateway }))
    const first = orchestrator.startRun()
    expect(orchestrator.busy).toBe(true)
    expect(() => orchestrator.startRun()).toThrow(DreamBusyError)
    settle()
    await first.done
    expect(orchestrator.busy).toBe(false)
    const second = orchestrator.startRun()
    await second.done
    expect(recorder.created).toHaveLength(2)
  })

  it('launches session dream-<uuid>, followups the prompt plus plan, disposes, and stamps after scoring', async () => {
    const fs = stampedFs({
      [`${DB}/state/relevancy.json`]: JSON.stringify({ [`${SHARED}/going-stale.md`]: 0.05 }),
    })
    const inventories = [inventory(SHARED, 'shared', [
      note(SHARED, 'touched', { meta: { read_count: 2, last_read_at: '2026-11-01' } }),
      note(SHARED, 'going-stale', { meta: { type: 'domain', read_count: 1, last_read_at: '2026-02-01' } }),
      note(SHARED, 'untouched', { meta: { type: 'domain' } }),
    ])]
    const recorder = fakeGateway()
    const logs: string[] = []
    const orchestrator = new DreamOrchestrator(deps({ fs, inventories, gateway: recorder.gateway, logs }))
    const handle = orchestrator.startRun()
    const summary = await handle.done
    expect(summary.ok).toBe(true)

    expect(handle.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i)
    expect(recorder.created).toEqual([{ sessionId: `dream-${handle.id}`, agentOptions: { provider: 'acme', model: 'm-1' }, meta: { cwd: DB } }])
    expect(recorder.calls).toEqual(['create', 'followup', 'whenIdle', 'dispose'])
    const message = recorder.followups[0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content[0]?.text).toContain('# Work plan for this run')
    expect(message.content[0]?.text).toContain('dreaming protocol')

    // Relevancy: touched bumped to 1.0 (read after the previous stamp),
    // going-stale decayed 0.05 -> 0 (flagged for archive review), untouched
    // never accessed and untracked so it stays out of the sidecar.
    const relevancy = JSON.parse(fs.files.get(`${DB}/state/relevancy.json`) ?? '{}') as Record<string, number>
    expect(relevancy).toEqual({
      [`${SHARED}/touched.md`]: 1,
      [`${SHARED}/going-stale.md`]: 0,
    })
    expect(summary.bumped).toBe(1)
    expect(summary.degraded).toBe(1)
    expect(summary.notes).toBe(3)
    expect(summary.archiveCandidates).toEqual([`${SHARED}/going-stale.md`])

    // Order load-bearing: scoring read the PREVIOUS stamp; only then did
    // the stamp move to now.
    const state = JSON.parse(fs.files.get(`${DB}/state/state.json`) ?? '{}') as { lastDreamAt: number }
    expect(state.lastDreamAt).toBeGreaterThan(Date.parse(LAST_DREAM_ISO))
    expect(logs.some((entry) => entry.includes('done'))).toBe(true)
  })

  it('launches with the host default model when override and config are unset (config empty string is unset)', async () => {
    const recorder = fakeGateway()
    const config = configFixture({ dreaming: { schedules: [], model: '', nearDuplicateThreshold: 0.92 } })
    await new DreamOrchestrator(deps({ gateway: recorder.gateway, config })).startRun().done
    expect(recorder.created[0]).toEqual({ sessionId: expect.stringMatching(/^dream-/), agentOptions: { provider: 'acme', model: 'm-1' }, meta: { cwd: DB } })
  })

  it('passes meta.cwd as the configured dbPath so the session lands in a GUI-addressable bucket', async () => {
    // A non-default dbPath pins the value to config.milvus.dbPath rather
    // than a constant: the session boundary keys the persisted transcript
    // bucket off meta.cwd, and its absence is why dream transcripts 404 in
    // the GUI (PLAN-dream-meta-cwd TASK-001).
    const recorder = fakeGateway()
    const config = configFixture({ milvus: { mode: 'spawn', address: '', dbPath: '/srv/other-mem-db', readinessTimeoutMs: 1 } })
    await new DreamOrchestrator(deps({ gateway: recorder.gateway, config })).startRun().done
    expect(recorder.created).toHaveLength(1)
    expect(recorder.created[0]?.meta).toEqual({ cwd: '/srv/other-mem-db' })
  })

  it('resolves the model by precedence: per-run override over config, config over host', async () => {
    const config = configFixture({ dreaming: { schedules: [], model: 'cfg/model', nearDuplicateThreshold: 0.92 } })
    const overridden = fakeGateway()
    await new DreamOrchestrator(deps({ gateway: overridden.gateway, config })).startRun({ model: 'some/model-x' }).done
    // The override replaces only the model id; provider routing is host-only.
    expect(overridden.created[0]).toEqual({ sessionId: expect.stringMatching(/^dream-/), agentOptions: { provider: 'acme', model: 'some/model-x' }, meta: { cwd: DB } })
    const configured = fakeGateway()
    await new DreamOrchestrator(deps({ gateway: configured.gateway, config })).startRun().done
    expect(configured.created[0]).toEqual({ sessionId: expect.stringMatching(/^dream-/), agentOptions: { provider: 'acme', model: 'cfg/model' }, meta: { cwd: DB } })
  })

  it('rejects the run as blocked when no provider/model pair resolves', () => {
    const recorder = fakeGateway()
    // No host route, config dreaming.model stays '', no per-run override.
    const orchestrator = new DreamOrchestrator(deps({
      gateway: recorder.gateway,
      defaultAgentOptions: () => undefined,
    }))
    expect(orchestrator.blockedReason()).toContain('no provider/model can be resolved')
    expect(() => orchestrator.startRun()).toThrow(DreamBlockedError)
    expect(orchestrator.busy).toBe(false)
    expect(recorder.created).toEqual([])
  })

  it('disposes even when whenIdle rejects, and the guard reopens with a failed summary', async () => {
    const fs = new MemFs()
    const recorder = fakeGateway({ whenIdle: () => Promise.reject(new Error('agent died')) })
    const orchestrator = new DreamOrchestrator(deps({ fs, gateway: recorder.gateway }))
    const handle = orchestrator.startRun()
    await expect(handle.done).rejects.toThrow('agent died')
    expect(recorder.calls).toEqual(['create', 'followup', 'whenIdle', 'dispose'])
    expect(orchestrator.busy).toBe(false)
    expect(orchestrator.lastSummary?.ok).toBe(false)
    expect(orchestrator.lastSummary?.error).toContain('agent died')
    // Failed run: no stamp, but the prompt seed (from plan) stands.
    expect(fs.files.has(`${DB}/state/state.json`)).toBe(false)
    expect(fs.files.has(`${DB}/dream-prompt.md`)).toBe(true)
  })

  it('rejects the run as blocked when no agents service is mounted', () => {
    const orchestrator = new DreamOrchestrator(deps({ gateway: null }))
    expect(orchestrator.blockedReason()).toContain('no agents service')
    expect(() => orchestrator.startRun()).toThrow(DreamBlockedError)
    expect(orchestrator.busy).toBe(false)
  })

  it('seeds the DREAMS.md diary once under the first shared vault metadata dir, creating parents', async () => {
    const fs = new MemFs()
    const inventories = [
      inventory(READ_ONLY, 'read-only', []),
      inventory(SHARED, 'shared', []),
    ]
    await new DreamOrchestrator(deps({ fs, inventories, gateway: fakeGateway().gateway })).startRun().done
    // New layout: the diary lives at <vault>/.obsidian-mem/metadata/DREAMS.md
    // and the sidecar dir is created on demand (un-migrated vaults lack it).
    expect(fs.mutations).toContain(`mkdirp ${SHARED}/.obsidian-mem/metadata`)
    const diary = fs.files.get(`${SHARED}/.obsidian-mem/metadata/DREAMS.md`)
    expect(diary).toContain('Dream (run')
    // Never a vault-root diary.
    expect(fs.files.has(`${SHARED}/DREAMS.md`)).toBe(false)
    // A second run must not touch the diary (agent-written or seeded).
    const before = fs.mutations.length
    await new DreamOrchestrator(deps({ fs, inventories, gateway: fakeGateway().gateway })).startRun().done
    expect(fs.mutations.slice(before).filter((entry) => entry.includes('DREAMS.md'))).toEqual([])
  })
})

// PLAN-budget-rebaseline TASK-002: the ok-path dep is how a successful
// compaction rebaselines the service-side global recall budget. Exactly
// once on success, never on any failure, busy, or plan path.
describe('run: onRunSucceeded ok-path dep', () => {
  it('fires exactly once, after the lastDreamAt stamp, on a successful run', async () => {
    const fs = stampedFs()
    const observedStamps: Array<number | null> = []
    const orchestrator = new DreamOrchestrator(deps({
      fs,
      gateway: fakeGateway().gateway,
      onRunSucceeded: () => {
        // Observe the stamp from inside the dep: only the ok-path write
        // moves it past the seeded LAST_DREAM_ISO value.
        const state = JSON.parse(fs.files.get(`${DB}/state/state.json`) ?? 'null') as { lastDreamAt?: number } | null
        observedStamps.push(state?.lastDreamAt ?? null)
      },
    }))
    const summary = await orchestrator.startRun().done
    expect(summary.ok).toBe(true)
    expect(observedStamps).toHaveLength(1)
    expect(observedStamps[0]).not.toBeNull()
    expect(observedStamps[0] as number).toBeGreaterThan(Date.parse(LAST_DREAM_ISO))
  })

  it('never fires when a failed turn aborts the run', async () => {
    let calls = 0
    const orchestrator = new DreamOrchestrator(deps({
      gateway: fakeGateway({ sessionEvents: [failedTurnError('dead agent')] }).gateway,
      onRunSucceeded: () => { calls += 1 },
    }))
    await expect(orchestrator.startRun().done).rejects.toThrow('dream agent turn failed: dead agent')
    expect(calls).toBe(0)
  })

  it('never fires when whenIdle rejects', async () => {
    let calls = 0
    const orchestrator = new DreamOrchestrator(deps({
      gateway: fakeGateway({ whenIdle: () => Promise.reject(new Error('agent died')) }).gateway,
      onRunSucceeded: () => { calls += 1 },
    }))
    await expect(orchestrator.startRun().done).rejects.toThrow('agent died')
    expect(calls).toBe(0)
  })

  it('never fires for a run refused as busy, and fires for the guarded run itself', async () => {
    let opened = false
    const resolvers: Array<() => void> = []
    const recorder = fakeGateway({
      whenIdle: () => (opened ? Promise.resolve() : new Promise<void>((resolve) => { resolvers.push(resolve) })),
    })
    let calls = 0
    const orchestrator = new DreamOrchestrator(deps({
      gateway: recorder.gateway,
      onRunSucceeded: () => { calls += 1 },
    }))
    const first = orchestrator.startRun()
    expect(() => orchestrator.startRun()).toThrow(DreamBusyError)
    expect(calls).toBe(0)
    opened = true
    resolvers.splice(0).forEach((resolve) => {
      resolve()
    })
    await first.done
    expect(calls).toBe(1)
  })

  it('never fires for a blocked startRun or a plan', async () => {
    let calls = 0
    const blocked = new DreamOrchestrator(deps({
      gateway: null,
      onRunSucceeded: () => { calls += 1 },
    }))
    expect(() => blocked.startRun()).toThrow(DreamBlockedError)
    await blocked.plan()
    expect(calls).toBe(0)
    await new DreamOrchestrator(deps({
      gateway: fakeGateway().gateway,
      onRunSucceeded: () => { calls += 1 },
    })).plan()
    expect(calls).toBe(0)
  })
})

describe('run: failed-turn detection from the session log (TASK-003)', () => {
  // The exact failure that killed every dream session since 2026-11-08:
  // agent-loop contains the turn error, whenIdle still resolves, and only
  // the transcript shows the dead agent.
  it('rejects the run on a turn/end error record, stamping nothing and running no post-pass', async () => {
    const fs = stampedFs()
    const inventories = [inventory(SHARED, 'shared', [
      note(SHARED, 'touched', { meta: { read_count: 2, last_read_at: '2026-11-01' } }),
    ])]
    const message = 'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")'
    const recorder = fakeGateway({ sessionEvents: [failedTurnError(message)] })
    const orchestrator = new DreamOrchestrator(deps({ fs, inventories, gateway: recorder.gateway }))
    const handle = orchestrator.startRun()
    await expect(handle.done).rejects.toThrow(`dream agent turn failed: ${message}`)
    expect(orchestrator.lastSummary?.ok).toBe(false)
    expect(orchestrator.lastSummary?.error).toContain(message)
    expect(orchestrator.busy).toBe(false)
    // The scan ran before dispose, and dispose still ran.
    expect(recorder.calls).toEqual(['create', 'followup', 'whenIdle', 'dispose'])
    // Failed run: previous stamp untouched, no relevancy sidecar, no diary seed.
    expect(orchestrator.lastDreamAt()).toBe(Date.parse(LAST_DREAM_ISO))
    expect(fs.files.has(`${DB}/state/relevancy.json`)).toBe(false)
    expect(fs.mutations.some((entry) => entry.includes('DREAMS.md'))).toBe(false)
  })

  it('falls back to "unknown error" when the error record carries no message', async () => {
    const recorder = fakeGateway({ sessionEvents: [turnEndRecord({ kind: 'error', error: {} })] })
    const orchestrator = new DreamOrchestrator(deps({ gateway: recorder.gateway }))
    await expect(orchestrator.startRun().done).rejects.toThrow('dream agent turn failed: unknown error')
    expect(orchestrator.lastSummary?.ok).toBe(false)
  })

  it('runs the post-pass and stamps on a clean transcript (turn/end reason kind "completed")', async () => {
    const fs = stampedFs()
    const inventories = [inventory(SHARED, 'shared', [
      note(SHARED, 'touched', { meta: { read_count: 2, last_read_at: '2026-11-01' } }),
    ])]
    const orchestrator = new DreamOrchestrator(deps({ fs, inventories, gateway: fakeGateway().gateway }))
    const summary = await orchestrator.startRun().done
    expect(summary.ok).toBe(true)
    expect(summary.bumped).toBe(1)
    const state = JSON.parse(fs.files.get(`${DB}/state/state.json`) ?? '{}') as { lastDreamAt: number }
    expect(state.lastDreamAt).toBeGreaterThan(Date.parse(LAST_DREAM_ISO))
    expect(fs.files.has(`${DB}/state/relevancy.json`)).toBe(true)
  })

  it('completes with a warning naming the slice when session or ownEvents is absent', async () => {
    const noSession = fakeGateway({ session: null })
    const noLogs: string[] = []
    const noSessionRun = await new DreamOrchestrator(deps({ gateway: noSession.gateway, logs: noLogs })).startRun().done
    expect(noSessionRun.ok).toBe(true)
    expect(noLogs.some((entry) => entry.includes('failed-turn check skipped') && entry.includes('agent.session'))).toBe(true)

    // A session object that lacks ownEvents is the second runtime lie.
    const hollowSession = fakeGateway({ session: { ownEvents: undefined } as never })
    const hollowLogs: string[] = []
    const hollowRun = await new DreamOrchestrator(deps({ gateway: hollowSession.gateway, logs: hollowLogs })).startRun().done
    expect(hollowRun.ok).toBe(true)
    expect(hollowLogs.some((entry) => entry.includes('failed-turn check skipped') && entry.includes('agent.session.ownEvents'))).toBe(true)
  })
})
