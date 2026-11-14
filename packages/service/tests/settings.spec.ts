import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_CHURN_WINDOW_COMMITS, modelCacheDir, stateDir } from '../../core/lib/index.js'
import {
  CARD_SETTINGS_KEYS,
  resolveServiceConfig,
  validateObsidianMemConfig,
} from '../src/config.ts'
import type { ObsidianMemConfig, ResolvedObsidianMemConfig } from '../src/config.ts'
import { ObsidianMemService, SETTINGS_FILE_NAME } from '../src/service.ts'
import type { ObsidianMemHooks, ServiceFs } from '../src/service.ts'

/**
 * Settings-override store tests for TASK-002: <state>/settings.json card
 * overrides beat the profile row config per whitelisted leaf; a partial
 * nested override keeps the row's sibling keys; the file anchors at the
 * fixed core stateDir even when the row moves dbPath; `~` and the ''
 * sentinel still resolve through the merge; a corrupt file self-heals, a
 * non-whitelist key is dropped with a warn, and a merged value that fails
 * validation falls back to the row-only config. Construction only: nothing
 * is written, and no provisioning runs.
 */

const HOME = '/home/test'
const SETTINGS_PATH = join(stateDir(HOME), SETTINGS_FILE_NAME)

// ---------------------------------------------------------------------------
// In-memory ServiceFs recording every mutating call.

class MemFs implements ServiceFs {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()
  readonly mutations: string[] = []

  seedFile(path: string, content: string): void {
    this.files.set(path, content)
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

function harness(options: { config?: ObsidianMemConfig; settings?: string } = {}) {
  const fs = new MemFs()
  if (options.settings !== undefined) fs.seedFile(SETTINGS_PATH, options.settings)
  const { ctx, warnings } = fakeCtx()
  const hooks: ObsidianMemHooks = { homedir: () => HOME, fs }
  const service = new ObsidianMemService(ctx, options.config ?? {}, hooks)
  return { fs, warnings, service }
}

// What the service would run on with no settings file at all: today's
// exact row-config path through validate + resolve.
function expectedConfig(row: ObsidianMemConfig): ResolvedObsidianMemConfig {
  const validated = validateObsidianMemConfig(row)
  if (validated.issues !== undefined) {
    throw new Error(`test row config invalid: ${validated.issues.map((i) => i.message).join('; ')}`)
  }
  return resolveServiceConfig(validated.value, HOME)
}

// ---------------------------------------------------------------------------

describe('settings.json card overrides (TASK-002)', () => {
  it('keeps today\'s behavior exactly when no settings file exists', () => {
    const row: ObsidianMemConfig = { vectorDim: 256, budgets: { searchTopK: 4 } }
    const { warnings, service } = harness({ config: row })
    expect(service.config).toEqual(expectedConfig(row))
    expect(warnings).toEqual([])
  })

  it('never writes or mkdirs at construction, only reads', () => {
    const { fs, service } = harness({
      config: {},
      settings: record({ budgets: { searchTopK: 9 } }),
    })
    expect(fs.mutations).toEqual([])
    expect(service.config.budgets.searchTopK).toBe(9)
  })

  it('beats the row config per leaf key', () => {
    const row: ObsidianMemConfig = { llm: { baseUrl: 'https://row.example' } }
    const { service } = harness({
      config: row,
      settings: record({ vectorDim: 256, llm: { enabled: true, baseUrl: 'https://card.example' } }),
    })
    expect(service.config.vectorDim).toBe(256)
    expect(service.config.llm).toEqual({
      enabled: true,
      baseUrl: 'https://card.example',
      model: '',
      apiKeyEnv: '',
    })
  })

  it('merges a git override leaf-wise over the row (enabled defaults to true)', () => {
    const row: ObsidianMemConfig = { git: { churnThresholdPercent: 60 } }
    const { service } = harness({
      config: row,
      settings: record({ git: { enabled: false } }),
    })
    expect(service.config.git).toEqual({
      enabled: false,
      churnThresholdPercent: 60,
      churnWindowCommits: DEFAULT_CHURN_WINDOW_COMMITS,
    })
  })

  it('merges a partial budgets override over the row\'s surviving siblings', () => {
    const row: ObsidianMemConfig = { budgets: { globalMemoryTokens: 2222, searchTopK: 4 } }
    const { service } = harness({
      config: row,
      settings: record({ budgets: { searchTopK: 9 } }),
    })
    expect(service.config.budgets).toEqual({
      turnStartRecallTokens: 1200,
      globalMemoryTokens: 2222,
      readSections: 2,
      readSectionTokens: 350,
      searchTopK: 9,
      thinkShotsPerTurn: 3,
    })
    // Untouched groups keep the row defaults exactly.
    expect(service.config.model).toEqual(expectedConfig({}).model)
  })

  it('loads settings.json from the fixed core stateDir even when the row moves dbPath', () => {
    const row: ObsidianMemConfig = { milvus: { dbPath: '/custom/db' } }
    const { service } = harness({
      config: row,
      settings: record({ budgets: { searchTopK: 7 } }),
    })
    expect(service.config.budgets.searchTopK).toBe(7)
    expect(service.config.milvus.dbPath).toBe('/custom/db')
  })

  it('ignores a settings file parked at the dbPath-derived state dir', () => {
    const fs = new MemFs()
    fs.seedFile(join('/custom/db', 'state', SETTINGS_FILE_NAME), record({ vectorDim: 256 }))
    const { ctx, warnings } = fakeCtx()
    const service = new ObsidianMemService(
      ctx,
      { milvus: { dbPath: '/custom/db' } },
      { homedir: () => HOME, fs },
    )
    expect(service.config.vectorDim).toBe(384)
    expect(warnings).toEqual([])
  })

  it('expands ~ in overrides and maps the model.cacheDir \'\' sentinel after the merge', () => {
    const row: ObsidianMemConfig = { model: { cacheDir: '/row/models' }, milvus: { dbPath: '/row/db' } }
    const { service } = harness({
      config: row,
      settings: record({ milvus: { dbPath: '~/memdb' }, model: { cacheDir: '' } }),
    })
    // `~` expands post-merge, exactly like a row value.
    expect(service.config.milvus.dbPath).toBe(join(HOME, 'memdb'))
    // '' is "the core default" via resolveServiceConfig, never a literal ''.
    expect(service.config.model.cacheDir).toBe(modelCacheDir(HOME))
  })

  it('self-heals a corrupt settings.json to the row-only config with a warn', () => {
    const row: ObsidianMemConfig = { vectorDim: 256 }
    const { warnings, service } = harness({ config: row, settings: '{ not json' })
    expect(warnings.join('\n')).toContain(SETTINGS_FILE_NAME)
    expect(service.config).toEqual(expectedConfig(row))
  })

  it('drops non-whitelist keys with a warn and keeps whitelist leaves in the same group', () => {
    const { warnings, service } = harness({
      settings: record({
        bogus: 1,
        dreaming: { model: 'some-model' },
        budgets: { bogusBudget: 5 },
        milvus: { mode: 'external', dbPath: '/card/db' },
      }),
    })
    const logged = warnings.join('\n')
    expect(logged).toContain('bogus')
    // Whole group has no whitelist leaves: the group itself is dropped.
    expect(logged).toContain('dreaming')
    // Unknown leaf inside a whitelisted group is named at its full path.
    expect(logged).toContain('budgets.bogusBudget')
    expect(logged).toContain('milvus.mode')
    expect(service.config.dreaming.model).toBe('')
    expect(service.config.budgets).toEqual(expectedConfig({}).budgets)
    expect(service.config.milvus.mode).toBe('spawn')
    // The whitelist leaf inside the same nested object survives the filter.
    expect(service.config.milvus.dbPath).toBe('/card/db')
  })

  it('falls back to the row config when the merged value fails validation', () => {
    const row: ObsidianMemConfig = { vectorDim: 256, budgets: { searchTopK: 4 } }
    const { warnings, service } = harness({
      config: row,
      // One bad leaf poisons the merge: the whole override set is dropped.
      settings: record({ vectorDim: 999, budgets: { searchTopK: 11 } }),
    })
    expect(warnings.join('\n')).toContain(`${SETTINGS_FILE_NAME} overrides rejected`)
    expect(service.config).toEqual(expectedConfig(row))
  })

  it('ignores overrides from a newer settings.json version', () => {
    const { warnings, service } = harness({ settings: record({ vectorDim: 256 }, 99) })
    expect(warnings.join('\n')).toContain('version 99')
    expect(service.config.vectorDim).toBe(384)
  })

  it('treats a record without an overrides object as no overrides', () => {
    const { warnings, service } = harness({ settings: '{"version":1}' })
    expect(warnings).toEqual([])
    expect(service.config).toEqual(expectedConfig({}))
  })

  it('holds exactly the README Configuration whitelist', () => {
    expect([...CARD_SETTINGS_KEYS].sort()).toEqual([
      'budgets.globalMemoryTokens',
      'budgets.readSectionTokens',
      'budgets.readSections',
      'budgets.searchTopK',
      'budgets.thinkShotsPerTurn',
      'budgets.turnStartRecallTokens',
      'git.churnThresholdPercent',
      'git.churnWindowCommits',
      'git.enabled',
      'llm.apiKeyEnv',
      'llm.baseUrl',
      'llm.enabled',
      'llm.model',
      'milvus.dbPath',
      'model.cacheDir',
      'model.id',
      'vectorDim',
    ])
  })
})
