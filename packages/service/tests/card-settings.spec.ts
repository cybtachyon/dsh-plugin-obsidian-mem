import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { dbDir, dbStateDir, modelCacheDir, stateDir } from '../../core/lib/index.js'
import {
  CARD_SETTINGS_KEYS,
  resolveServiceConfig,
  validateObsidianMemConfig,
} from '../src/config.ts'
import type { ObsidianMemConfig, ResolvedObsidianMemConfig } from '../src/config.ts'
import {
  ObsidianMemService,
  SETTINGS_FILE_NAME,
  VAULTS_FILE_NAME,
} from '../src/service.ts'
import type { ObsidianMemHooks, ServiceFs } from '../src/service.ts'

/**
 * Card-settings service API tests for TASK-003: cardSettings answers the
 * persisted effective view (settings.json merged over the running config,
 * home-expanded) with exactly the whitelisted leaves and the stored
 * overrides; updateCardSettings persists a validated patch atomically and
 * rejects (without touching disk) non-whitelist keys, bad values, and
 * non-whitelist unset paths; resetCardSettings restores the row values; a
 * persisted milvus.dbPath move flips restartPending and carries the live
 * vaults.json into the new state dir; a file hand-edited into junk after
 * boot keeps the view on the running values. Nothing provisions: every
 * scenario runs on the inactive phase.
 */

const HOME = '/home/test'
const SETTINGS_PATH = join(stateDir(HOME), SETTINGS_FILE_NAME)
const DEFAULT_VAULTS_PATH = join(dbStateDir(dbDir(HOME)), VAULTS_FILE_NAME)

// ---------------------------------------------------------------------------
// In-memory ServiceFs recording every mutating call.

class MemFs implements ServiceFs {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()
  readonly mutations: string[] = []

  seedFile(path: string, content: string): void {
    this.files.set(path, content)
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null
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

  writeFile(path: string, contents: string): void {
    this.mutations.push(`writeFile ${path}`)
    this.files.set(path, contents)
  }

  rename(from: string, to: string): void {
    this.mutations.push(`rename ${from} -> ${to}`)
    const file = this.files.get(from)
    this.files.delete(from)
    if (file !== undefined) this.files.set(to, file)
  }

  unlink(path: string): void {
    this.mutations.push(`unlink ${path}`)
    this.files.delete(path)
  }

  stat(_path: string): { mtimeMs: number } | null {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fake ctx: only what construction consumes (seam provide + logger).

function fakeCtx() {
  const warnings: string[] = []
  const ctx = {
    reflect: {
      provide: () => () => {},
    },
    logger: () => ({
      info: () => {},
      warn: (message: unknown) => { warnings.push(String(message)) },
      error: () => {},
      debug: () => {},
    }),
    effect: (execute: () => () => unknown) => { execute(); return () => {} },
    get: () => undefined,
  }
  return { ctx: ctx as unknown as Context, warnings }
}

function record(overrides: Record<string, unknown>, version = 1): string {
  return JSON.stringify({ version, overrides })
}

function harness(options: { config?: ObsidianMemConfig; settings?: string; vaults?: string } = {}) {
  const fs = new MemFs()
  if (options.settings !== undefined) fs.seedFile(SETTINGS_PATH, options.settings)
  if (options.vaults !== undefined) fs.seedFile(DEFAULT_VAULTS_PATH, options.vaults)
  const { ctx, warnings } = fakeCtx()
  const hooks: ObsidianMemHooks = { homedir: () => HOME, fs }
  const service = new ObsidianMemService(ctx, options.config ?? {}, hooks)
  return { fs, warnings, service }
}

// The card-editable leaf dot-paths of a view object, for the whitelist
// lockstep assertions.
function leafPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, given]) => (
    typeof given === 'object' && given !== null && !Array.isArray(given)
      ? leafPaths(given as object, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  ))
}

function storedOverrides(fs: MemFs): Record<string, unknown> {
  const raw = fs.readFile(SETTINGS_PATH)
  expect(raw).not.toBeNull()
  const parsed = JSON.parse(raw!) as { version: number; overrides: Record<string, unknown> }
  expect(parsed.version).toBe(1)
  return parsed.overrides
}

// What the service would run on with no overrides at all: the row config
// through validate + resolve, narrowed the way the union requires.
function expectedRow(row: ObsidianMemConfig): ResolvedObsidianMemConfig {
  const validated = validateObsidianMemConfig(row)
  if (validated.issues !== undefined) {
    throw new Error(`test row config invalid: ${validated.issues.map((i) => i.message).join('; ')}`)
  }
  return resolveServiceConfig(validated.value, HOME)
}

// ---------------------------------------------------------------------------

describe('cardSettings view (TASK-003)', () => {
  it('answers the defaults with no settings file, without provisioning', () => {
    const { fs, service } = harness()
    const view = service.cardSettings()
    const row = expectedRow({})
    expect(view.settings).toEqual({
      vectorDim: row.vectorDim,
      model: { id: row.model.id, cacheDir: row.model.cacheDir },
      milvus: { dbPath: row.milvus.dbPath },
      budgets: row.budgets,
      llm: row.llm,
    })
    expect(view.overrides).toEqual({})
    expect(view.restartPending).toEqual([])
    expect(service.status().state).toBe('inactive')
    expect(fs.mutations).toEqual([])
  })

  it('exposes exactly the whitelisted leaf paths in the settings view', () => {
    const { service } = harness()
    expect(leafPaths(service.cardSettings().settings).sort()).toEqual(
      [...CARD_SETTINGS_KEYS].sort(),
    )
  })

  it('shows stored overrides home-expanded and the sentinel cleared to the default', () => {
    const { service } = harness({
      config: { model: { cacheDir: '/row/models' } },
      settings: record({ milvus: { dbPath: '~/memdb' }, model: { cacheDir: '' } }),
    })
    const view = service.cardSettings()
    expect(view.settings.milvus.dbPath).toBe(join(HOME, 'memdb'))
    expect(view.settings.model.cacheDir).toBe(modelCacheDir(HOME))
    expect(view.overrides).toEqual({ milvus: { dbPath: '~/memdb' }, model: { cacheDir: '' } })
    // The view is a copy: editing the returned object cannot reach the
    // running config.
    view.settings.budgets.searchTopK = 12345
    expect(service.config.budgets.searchTopK).not.toBe(12345)
  })

  it('keeps hand-edited junk out of the view while the file still reports it', () => {
    const { fs, service } = harness()
    fs.seedFile(SETTINGS_PATH, record({ vectorDim: 'wide' }))
    const view = service.cardSettings()
    expect(view.settings.vectorDim).toBe(384)
    expect(view.overrides).toEqual({ vectorDim: 'wide' })
    expect(view.restartPending).toEqual([])
    // An apply over stored junk rejects until the file is fixed or reset.
    expect(() => service.updateCardSettings({ set: { budgets: { searchTopK: 9 } } }))
      .toThrow(/vectorDim/)
  })
})

describe('updateCardSettings (TASK-003)', () => {
  it('persists a whitelisted patch atomically and answers the fresh view', () => {
    const { fs, service } = harness({ config: { budgets: { searchTopK: 4 } } })
    const view = service.updateCardSettings({ set: { budgets: { searchTopK: 9 } } })
    expect(view.settings.budgets.searchTopK).toBe(9)
    expect(view.overrides).toEqual({ budgets: { searchTopK: 9 } })
    expect(storedOverrides(fs)).toEqual({ budgets: { searchTopK: 9 } })
    expect(fs.mutations).toEqual([
      `mkdirp ${stateDir(HOME)}`,
      `writeFile ${SETTINGS_PATH}.obsidian-mem.tmp`,
      `rename ${SETTINGS_PATH}.obsidian-mem.tmp -> ${SETTINGS_PATH}`,
    ])
    // Never provisions: the phase stays inactive.
    expect(service.status().state).toBe('inactive')
  })

  it('keeps stored siblings when a later patch touches one leaf', () => {
    const { fs, service } = harness()
    service.updateCardSettings({ set: { budgets: { searchTopK: 9 } } })
    service.updateCardSettings({ set: { budgets: { readSections: 5 }, llm: { enabled: true } } })
    expect(storedOverrides(fs)).toEqual({
      budgets: { searchTopK: 9, readSections: 5 },
      llm: { enabled: true },
    })
    const view = service.cardSettings()
    expect(view.settings.budgets.searchTopK).toBe(9)
    expect(view.settings.budgets.readSections).toBe(5)
    expect(view.settings.llm.enabled).toBe(true)
  })

  it('rejects an off-whitelist key and a non-object group without persisting', () => {
    const { fs, service } = harness()
    expect(() => service.updateCardSettings({ set: { bogus: 1 } as never }))
      .toThrow(/not card-editable: bogus/)
    expect(() => service.updateCardSettings({ set: { budgets: { bogusBudget: 5 } } as never }))
      .toThrow(/not card-editable: budgets\.bogusBudget/)
    expect(() => service.updateCardSettings({ set: { budgets: 'all' } as never }))
      .toThrow(/not card-editable: budgets/)
    expect(fs.mutations).toEqual([])
  })

  it('rejects values failing the config schema without persisting', () => {
    const { service } = harness()
    // Bad enum member.
    expect(() => service.updateCardSettings({ set: { vectorDim: 999 } }))
      .toThrow(/vectorDim must be 384/)
    // Negative budget.
    expect(() => service.updateCardSettings({ set: { budgets: { searchTopK: -1 } } }))
      .toThrow(/budgets\.searchTopK must be a positive number/)
    // model.id keeps its non-empty rule.
    expect(() => service.updateCardSettings({ set: { model: { id: '  ' } } }))
      .toThrow(/model\.id must be a non-empty string/)
  })

  it('rejects unsetting a non-whitelist path without persisting', () => {
    const { fs, service } = harness()
    expect(() => service.updateCardSettings({ set: {}, unset: ['milvus.mode'] }))
      .toThrow(/not card-editable: milvus\.mode/)
    expect(() => service.updateCardSettings({ set: {}, unset: ['budgets'] }))
      .toThrow(/not card-editable: budgets/)
    expect(fs.mutations).toEqual([])
  })

  it('unset drops the stored key so the row value returns to the view', () => {
    const { fs, service } = harness({
      config: { budgets: { searchTopK: 4 } },
      settings: record({ budgets: { searchTopK: 9 }, vectorDim: 256 }),
    })
    expect(service.cardSettings().settings.budgets.searchTopK).toBe(9)
    const view = service.updateCardSettings({ set: {}, unset: ['budgets.searchTopK'] })
    expect(view.settings.budgets.searchTopK).toBe(4)
    expect(view.settings.vectorDim).toBe(256)
    expect(storedOverrides(fs)).toEqual({ vectorDim: 256 })
    expect(view.overrides).toEqual({ vectorDim: 256 })
  })
})

describe('milvus.dbPath special effect (TASK-003)', () => {
  const VAULTS_RECORD = JSON.stringify({
    version: 1,
    vaults: [{ path: '/vault/one', mode: 'shared', globalFile: 'GLOBAL.md' }],
  })

  it('flips restartPending and carries vaults.json to the new state dir', () => {
    const { fs, service } = harness({ vaults: VAULTS_RECORD })
    const view = service.updateCardSettings({ set: { milvus: { dbPath: '/second/db' } } })
    expect(view.settings.milvus.dbPath).toBe('/second/db')
    expect(view.restartPending).toEqual(['milvus.dbPath'])
    // The in-process subsystem keeps running on the old dir (persist-only).
    expect(service.config.milvus.dbPath).toBe(dbDir(HOME))
    // The live vaults.json is copied into the next host start's state dir.
    expect(fs.readFile(join(dbStateDir('/second/db'), VAULTS_FILE_NAME))).toBe(VAULTS_RECORD)
    // The override file itself stays anchored at the fixed core state dir.
    expect(storedOverrides(fs)).toEqual({ milvus: { dbPath: '/second/db' } })
  })

  it('skips the carry when there is no vaults.json yet', () => {
    const { fs, service } = harness()
    service.updateCardSettings({ set: { milvus: { dbPath: '/second/db' } } })
    expect(fs.readFile(join(dbStateDir('/second/db'), VAULTS_FILE_NAME))).toBeNull()
    expect(fs.mutations).not.toContain(`mkdirp ${dbStateDir('/second/db')}`)
  })

  it('carries vaults.json back when a reset clears a pending dbPath override', () => {
    const { fs, service } = harness({
      config: { milvus: { dbPath: '/row/db' } },
      settings: record({ milvus: { dbPath: '/new/db' } }),
    })
    // Boot merged the override: this process reads vaults.json under /new/db.
    fs.seedFile(join(dbStateDir('/new/db'), VAULTS_FILE_NAME), VAULTS_RECORD)
    const view = service.resetCardSettings()
    expect(view.settings.milvus.dbPath).toBe('/row/db')
    // The running process is still on /new/db until a restart, so it pends.
    expect(view.restartPending).toEqual(['milvus.dbPath'])
    expect(service.config.milvus.dbPath).toBe('/new/db')
    expect(fs.readFile(join(dbStateDir('/row/db'), VAULTS_FILE_NAME))).toBe(VAULTS_RECORD)
  })
})

describe('resetCardSettings (TASK-003)', () => {
  it('clears every override back to the row values', () => {
    const row: ObsidianMemConfig = { vectorDim: 256, budgets: { searchTopK: 4 } }
    const { fs, service } = harness({
      config: row,
      settings: record({ vectorDim: 128, llm: { enabled: true } }),
    })
    expect(service.cardSettings().settings.vectorDim).toBe(128)
    const view = service.resetCardSettings()
    expect(view.settings.vectorDim).toBe(256)
    expect(view.settings.budgets.searchTopK).toBe(4)
    expect(view.settings.llm.enabled).toBe(false)
    expect(view.overrides).toEqual({})
    expect(storedOverrides(fs)).toEqual({})
    // The stub escalation (TASK-004) leaves the boot-merged values running,
    // so the reset leaves report themselves as restartPending.
    expect(view.restartPending.sort()).toEqual(['llm.enabled', 'vectorDim'])
  })

  it('writes the empty record even when no settings file existed', () => {
    const { fs, service } = harness()
    expect(fs.readFile(SETTINGS_PATH)).toBeNull()
    service.resetCardSettings()
    expect(storedOverrides(fs)).toEqual({})
  })
})
