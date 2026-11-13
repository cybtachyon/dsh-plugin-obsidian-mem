import { describe, expect, it } from 'vitest'

import {
  DREAM_NEAR_DUPLICATE_THRESHOLD,
  DEFAULT_MODEL_ID,
  GLOBAL_MEMORY_FILE_DEFAULT,
  MILVUS_SCALAR_MAX_LENGTHS,
  VECTOR_DIM_DEFAULT,
  dbDir,
} from '../../core/lib/index.js'
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  expandHomePath,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
  vaultKey,
} from '../src/config.ts'
import type {
  ConfigIssue,
  ObsidianMemConfig,
  ObsidianMemConfigValidation,
  ResolvedObsidianMemConfig,
} from '../src/config.ts'

/**
 * Config validation spec (TASK-060): the hand-rolled Standard-Schema is the
 * loud gate between a garbage row config and a running plugin. Wrong types
 * and out-of-enum values must produce issues with precise paths; unknown
 * keys must NOT throw but land on UNKNOWN_CONFIG_KEYS; a mounted `{}` is a
 * complete config. resolveServiceConfig is the only place $HOME enters.
 */

function issuesOf(result: ObsidianMemConfigValidation): readonly ConfigIssue[] {
  if (result.issues === undefined) {
    return []
  }
  return result.issues
}

function validate(value: unknown): ObsidianMemConfigValidation {
  return validateObsidianMemConfig(value)
}

function paths(issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => issue.path.join('.'))
}

describe('validateObsidianMemConfig: whole-config defaults', () => {
  it.each([[undefined], [null], [{}]])(
    'resolves a mounted %s to the complete default config',
    (value) => {
      const result = validate(value)

      expect(issuesOf(result)).toEqual([])
      const config = (result as { value: ResolvedObsidianMemConfig }).value
      expect(config.vaults).toEqual([])
      expect(config.vectorDim).toBe(VECTOR_DIM_DEFAULT)
      expect(config.model).toEqual({ id: DEFAULT_MODEL_ID, dtype: 'q8' })
      expect(config.milvus).toEqual({
        mode: 'spawn',
        address: '',
        dbPath: '',
        readinessTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
      })
      expect(config.llm).toEqual({ enabled: false, baseUrl: '', model: '', apiKeyEnv: '' })
      expect(config.dreaming.nearDuplicateThreshold).toBe(DREAM_NEAR_DUPLICATE_THRESHOLD)
      expect(config.dreaming.schedules).toEqual([])
    },
  )

  it('collects unknown keys without failing, at every nesting level', () => {
    const result = validate({
      typoTop: 1,
      milvus: { address: '127.0.0.1:19530', typoNested: true },
      budgets: { searchTopK: 5, typoBudget: -2 },
    })

    expect(issuesOf(result)).toEqual([])
    const unknown = (result as { value: Record<symbol, unknown> }).value[UNKNOWN_CONFIG_KEYS] as string[]
    expect(unknown).toContain('typoTop')
    expect(unknown).toContain('milvus.typoNested')
    expect(unknown).toContain('budgets.typoBudget')
    // Unknown values never reach the resolved config the plugin runs on.
    const resolved = (result as { value: ResolvedObsidianMemConfig }).value
    expect(Object.keys(resolved).sort()).toEqual(
      ['budgets', 'dreaming', 'llm', 'milvus', 'model', 'vaults', 'vectorDim'].sort(),
    )
    expect(resolved.budgets.searchTopK).toBe(5)
  })

  it('truncates fractional budget numbers to integers', () => {
    const result = validate({ budgets: { searchTopK: 5.9, readSections: 2.2 } })

    const resolved = (result as { value: ResolvedObsidianMemConfig }).value
    expect(resolved.budgets.searchTopK).toBe(5)
    expect(resolved.budgets.readSections).toBe(2)
  })
})

describe('validateObsidianMemConfig: rejection table', () => {
  const cases: Array<[label: string, value: ObsidianMemConfig | unknown, expectedPaths: string[]]> = [
    ['non-object config', 'vaults', ['']],
    ['vaults not an array', { vaults: '/tmp/v' }, ['vaults']],
    ['vault entry not an object', { vaults: ['x'] }, ['vaults.0']],
    ['vault path blank', { vaults: [{ path: '  ' }] }, ['vaults.0.path']],
    ['vault mode not in enum', { vaults: [{ path: '/v', mode: 'writable' }] }, ['vaults.0.mode']],
    ['vault globalFile leading slash', { vaults: [{ path: '/v', globalFile: '/GLOBAL.md' }] }, ['vaults.0.globalFile']],
    ['vault globalFile .. segment', { vaults: [{ path: '/v', globalFile: 'memory/../GLOBAL.md' }] }, ['vaults.0.globalFile']],
    ['vault globalFile bare ..', { vaults: [{ path: '/v', globalFile: '..' }] }, ['vaults.0.globalFile']],
    ['vault globalFile not a string', { vaults: [{ path: '/v', globalFile: 42 }] }, ['vaults.0.globalFile']],
    ['vectorDim off the whitelist', { vectorDim: 250 }, ['vectorDim']],
    ['model not an object', { model: 'e5' }, ['model']],
    ['model.id blank', { model: { id: '  ' } }, ['model.id']],
    ['milvus not an object', { milvus: 'spawn' }, ['milvus']],
    ['milvus.mode not in enum', { milvus: { mode: 'remote' } }, ['milvus.mode']],
    ['milvus.readinessTimeoutMs not positive', { milvus: { readinessTimeoutMs: 0 } }, ['milvus.readinessTimeoutMs']],
    ['milvus.address not a string', { milvus: { address: 42 } }, ['milvus.address']],
    ['budgets not an object', { budgets: 10 }, ['budgets']],
    ['budget not a positive number', { budgets: { searchTopK: -1 } }, ['budgets.searchTopK']],
    ['llm not an object', { llm: true }, ['llm']],
    ['llm.enabled not a boolean', { llm: { enabled: 'yes' } }, ['llm.enabled']],
    ['llm.model not a string', { llm: { model: 7 } }, ['llm.model']],
    ['dreaming not an object', { dreaming: 'nightly' }, ['dreaming']],
    ['nearDuplicateThreshold out of range', { dreaming: { nearDuplicateThreshold: 1.5 } },
      ['dreaming.nearDuplicateThreshold']],
    ['dreaming.model not a string', { dreaming: { model: 1 } }, ['dreaming.model']],
  ]

  it.each(cases)('%s reports an issue at the config path', (_label, value, expectedPaths) => {
    const issues = issuesOf(validate(value))

    expect(paths(issues)).toEqual(expect.arrayContaining(expectedPaths))
    expect(issues.length).toBeGreaterThan(0)
  })

  it('reports every issue in one pass instead of only the first', () => {
    const issues = issuesOf(validate({ vectorDim: -1, llm: { enabled: 'on' }, budgets: { searchTopK: 'x' } }))

    expect(paths(issues).sort()).toEqual(['budgets.searchTopK', 'llm.enabled', 'vectorDim'])
  })
})

describe('validateObsidianMemConfig: dreaming schedules', () => {
  it('accepts cron and everySeconds rows, each with exactly one trigger', () => {
    const result = validate({
      dreaming: {
        schedules: [
          { id: 'nightly', label: 'Nightly', expression: '0 3 * * *' },
          { id: 'weekly', label: 'Weekly', everySeconds: 604_800 },
        ],
      },
    })

    expect(issuesOf(result)).toEqual([])
    const resolved = (result as { value: ResolvedObsidianMemConfig }).value
    expect(resolved.dreaming.schedules).toEqual([
      { id: 'nightly', label: 'Nightly', expression: '0 3 * * *' },
      { id: 'weekly', label: 'Weekly', everySeconds: 604_800 },
    ])
  })

  const badRows: Array<[label: string, row: unknown, path: string]> = [
    ['non-array schedules', 'nightly', 'dreaming.schedules'],
    ['row not an object', 7, 'dreaming.schedules.0'],
    ['blank id', { id: ' ', label: 'x', expression: '* * * * *' }, 'dreaming.schedules.0.id'],
    ['missing label', { id: 'a', expression: '* * * * *' }, 'dreaming.schedules.0.label'],
    ['both triggers', { id: 'a', label: 'x', expression: '* * * * *', everySeconds: 60 }, 'dreaming.schedules.0'],
    ['neither trigger', { id: 'a', label: 'x' }, 'dreaming.schedules.0'],
    ['expression not a string', { id: 'a', label: 'x', expression: 5 }, 'dreaming.schedules.0.expression'],
    ['everySeconds not positive', { id: 'a', label: 'x', everySeconds: 0 }, 'dreaming.schedules.0.everySeconds'],
  ] as const

  it.each(badRows)('%s names the offending row path', (_label, schedulesValue, expectedPath) => {
    const schedules = typeof schedulesValue === 'string' ? schedulesValue : [schedulesValue]
    const issues = issuesOf(validate({ dreaming: { schedules } }))

    expect(paths(issues)).toContain(expectedPath)
  })
})

describe('validateObsidianMemConfig: vault globalFile', () => {
  it('defaults an omitted globalFile to the layout default', () => {
    const resolved = (validate({ vaults: [{ path: '/v' }] }) as { value: ResolvedObsidianMemConfig }).value

    expect(resolved.vaults).toEqual([
      { path: '/v', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    ])
  })

  it('keeps an explicit root name and a nested relative path (trimmed)', () => {
    const resolved = (validate({
      vaults: [
        { path: '/v', globalFile: 'GLOBAL.md' },
        { path: '/w', globalFile: ' memory/GLOBAL.md ' },
      ],
    }) as { value: ResolvedObsidianMemConfig }).value

    expect(resolved.vaults.map((v) => v.globalFile)).toEqual(['GLOBAL.md', 'memory/GLOBAL.md'])
  })

  it('defaults a blank or whitespace-only globalFile like core resolveVaults (R1 ruling)', () => {
    const resolved = (validate({
      vaults: [{ path: '/v', globalFile: '' }, { path: '/w', globalFile: '   ' }],
    }) as { value: ResolvedObsidianMemConfig }).value

    expect(resolved.vaults.map((v) => v.globalFile)).toEqual([
      GLOBAL_MEMORY_FILE_DEFAULT,
      GLOBAL_MEMORY_FILE_DEFAULT,
    ])
  })

  it('treats globalFile as a known vault key: never in UNKNOWN_CONFIG_KEYS', () => {
    const result = validate({ vaults: [{ path: '/v', globalFile: 'G.md', typoVault: 1 }] })

    expect(issuesOf(result)).toEqual([])
    const unknown = (result as { value: Record<symbol, unknown> }).value[UNKNOWN_CONFIG_KEYS] as string[]
    expect(unknown).toEqual(['vaults.0.typoVault'])
  })
})

describe('resolveServiceConfig and path helpers', () => {
  it('expands ~ and relativizes vault paths against the home, filling the dbPath default', () => {
    const validated = validate({
      vaults: [{ path: '~/notes' }, { path: '/abs/vault', globalFile: 'memory/GLOBAL.md' }],
    })
    const config = (validated as { value: ResolvedObsidianMemConfig }).value

    const resolved = resolveServiceConfig(config, '/home/tester')

    // globalFile is vault-root-relative: resolution never touches it.
    expect(resolved.vaults).toEqual([
      { path: '/home/tester/notes', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      { path: '/abs/vault', mode: 'shared', globalFile: 'memory/GLOBAL.md' },
    ])
    expect(resolved.milvus.dbPath).toBe(dbDir('/home/tester'))
  })

  it('expands a configured dbPath too, and keeps an absolute one', () => {
    const validated = validate({ milvus: { dbPath: '~/mem-db' } })
    const config = (validated as { value: ResolvedObsidianMemConfig }).value

    expect(resolveServiceConfig(config, '/home/tester').milvus.dbPath).toBe('/home/tester/mem-db')
  })

  it('expandHomePath passes absolute paths through and resolves relative ones against home', () => {
    expect(expandHomePath('~', '/h')).toBe('/h')
    expect(expandHomePath('~/a/b', '/h')).toBe('/h/a/b')
    expect(expandHomePath('/already/abs', '/h')).toBe('/already/abs')
    expect(expandHomePath('relative/dir', '/h')).toBe('/h/relative/dir')
  })

  it('vaultKey truncates to the stored vault column width', () => {
    const long = `/${'x'.repeat(500)}`

    expect(vaultKey(long)).toBe(long.slice(0, MILVUS_SCALAR_MAX_LENGTHS.vault))
    expect(vaultKey(long).length).toBe(MILVUS_SCALAR_MAX_LENGTHS.vault)
  })
})
