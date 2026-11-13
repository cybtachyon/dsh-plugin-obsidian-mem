/**
 * memory_dream tool tests (TASK-035): request forwarding, the guard-error
 * mapping (DreamBusyError -> dream_running, DreamBlockedError ->
 * dream_blocked, never a throw to the host), a `run` answer that returns
 * immediately and swallows the background outcome, closed-union schema
 * conformance for every kind, and the DoD requirement that the tool
 * description itself carries the usage timing and scheduling note (there
 * is no system-prompt injection variant for dreaming).
 */

import { describe, expect, it } from 'vitest'

import { TOOL_MEMORY_DREAM } from '../../core/lib/index.js'
import { DreamBlockedError, DreamBusyError } from '../../service/lib/dream.js'
import type { DreamEngineResult, DreamPlan } from '../../service/lib/dream.js'
import { DREAM_TIMEOUT_MS, createDreamTool, executeDream, renderDream } from '../src/dream.ts'
import { createFakeService, matchesOutput } from './testkit.ts'

function planFixture(over: Partial<DreamPlan> = {}): DreamPlan {
  return {
    generatedAt: 1730000000000,
    lastDreamAt: 1729000000000,
    prompt: '# dreaming protocol\nbudget 1500\n',
    plan: '1. Compact global note /v/a.md.\n2. Global budget headroom: 1800 of 1500 tokens used.',
    candidates: [
      {
        path: '/v/a.md',
        vaultPath: '/v',
        rel: 'a.md',
        mode: 'shared',
        reasons: ['never-read', 'global-over-budget'],
        readCount: 0,
        lastReadAt: '',
        sizeBytes: 2048,
      },
    ],
    clusters: [['/v/a.md', '/v/b.md']],
    stats: { notes: 4, globalNotes: 2, oversized: 1, staleOrUnread: 2, totalBytes: 8192 },
    budget: {
      budgetTokens: 1500,
      usedTokens: 1800,
      measured: true,
      overBudget: true,
      globalNoteCount: 2,
      globalNotePaths: ['/v/a.md', '/v/b.md'],
      compactableGlobalNotePaths: ['/v/a.md', '/v/b.md'],
    },
    skipped: [],
    ...over,
  }
}

function planResult(): DreamEngineResult {
  return { operation: 'plan', plan: planFixture() }
}

/** A run handle whose background promise fails on purpose. */
function runResult(): DreamEngineResult {
  const rejection = Promise.reject(new Error('background boom'))
  return { operation: 'run', id: 'run-42', done: rejection } as unknown as DreamEngineResult
}

describe('memory_dream execute', () => {
  it('defaults to plan, forwards operation and model, and maps the plan value', async () => {
    const service = createFakeService({ vaults: [], dreamResult: planResult() })
    const definition = createDreamTool(service)
    const value = await executeDream(service, {})
    expect(service.dreamRequests).toEqual([{}])
    expect(matchesOutput(definition, value)).toEqual([])
    if (value.kind !== 'plan') {
      throw new Error('expected the plan kind')
    }
    expect(value.generated_at).toBe(new Date(1730000000000).toISOString())
    expect(value.last_dream_at).toBe(new Date(1729000000000).toISOString())
    expect(value.candidates[0]).toEqual({
      path: '/v/a.md',
      vault_path: '/v',
      mode: 'shared',
      reasons: ['never-read', 'global-over-budget'],
      read_count: 0,
      last_read_at: '',
      size_bytes: 2048,
    })
    expect(value.clusters).toEqual([['/v/a.md', '/v/b.md']])
    await executeDream(service, { operation: 'run', model: 'some/model' })
    expect(service.dreamRequests[1]).toEqual({ operation: 'run', model: 'some/model' })
  })

  it('rejects an unknown operation before touching the service', async () => {
    const service = createFakeService({ vaults: [], dreamResult: planResult() })
    await expect(executeDream(service, { operation: 'compact' })).rejects.toThrow('operation')
    expect(service.dreamRequests).toEqual([])
  })

  it('answers started without awaiting the run, swallowing its failure', async () => {
    const unhandled: unknown[] = []
    const capture = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', capture)
    const service = createFakeService({ vaults: [], dreamResult: runResult() })
    const definition = createDreamTool(service)
    const value = await executeDream(service, { operation: 'run' })
    expect(matchesOutput(definition, value)).toEqual([])
    expect(value.kind).toBe('started')
    if (value.kind === 'started') {
      expect(value.run_id).toBe('run-42')
      expect(value.message).toContain('background')
    }
    // Give the rejected background promise a chance to surface unhandled.
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    process.off('unhandledRejection', capture)
    expect(unhandled).toEqual([])
  })

  it('maps the guard rejections to kind values, not throws', async () => {
    const busyService = createFakeService({ vaults: [], dreamError: new DreamBusyError('already in flight') })
    const blockedService = createFakeService({ vaults: [], dreamError: new DreamBlockedError('no agents service') })
    const definition = createDreamTool(busyService)
    const busy = await executeDream(busyService, { operation: 'run' })
    const blocked = await executeDream(blockedService, { operation: 'run' })
    expect(matchesOutput(definition, busy)).toEqual([])
    expect(matchesOutput(createDreamTool(blockedService), blocked)).toEqual([])
    expect(busy).toEqual({ kind: 'dream_running', message: 'already in flight' })
    expect(blocked).toEqual({ kind: 'dream_blocked', message: 'no agents service' })
  })

  it('returns the failed kind for any other service fault', async () => {
    const service = createFakeService({ vaults: [] })
    const definition = createDreamTool(service)
    const value = await executeDream(service, {})
    expect(matchesOutput(definition, value)).toEqual([])
    expect(value.kind).toBe('failed')
    if (value.kind === 'failed') {
      expect(value.message).toContain('memory_dream could not complete')
    }
  })
})

describe('memory_dream render', () => {
  it('renders the work plan, budget state, candidates, and skips', async () => {
    const service = createFakeService({ vaults: [], dreamResult: planResult() })
    const text = renderDream(await executeDream(service, {}))
    expect(text).toContain('last dream: 2024-10-15')
    expect(text).toContain('2 stale or never-read')
    expect(text).toContain('1. Compact global note /v/a.md.')
    expect(text).toContain('OVER BUDGET: 1800 of 1500 tokens used')
    expect(text).toContain('- /v/a.md [shared] (never-read, global-over-budget; never read)')
    expect(text).toContain('omitted here')
  })

  it('renders a never-dreamed store and a quiet budget honestly', async () => {
    const service = createFakeService({
      vaults: [],
      dreamResult: {
        operation: 'plan',
        plan: planFixture({
          lastDreamAt: null,
          candidates: [],
          clusters: [],
          budget: { budgetTokens: 1500, usedTokens: 0, measured: false, overBudget: false, globalNoteCount: 0, globalNotePaths: [], compactableGlobalNotePaths: [] },
        }),
      },
    })
    const text = renderDream(await executeDream(service, {}))
    expect(text).toContain('last dream: never')
    expect(text).toContain('No recall budget spent in this process yet')
    expect(text).not.toContain('OVER BUDGET')
  })

  it('renders a protected-only over-budget store as compaction that cannot help', async () => {
    const service = createFakeService({
      vaults: [],
      dreamResult: {
        operation: 'plan',
        plan: planFixture({
          budget: {
            budgetTokens: 1500,
            usedTokens: 1800,
            measured: true,
            overBudget: true,
            globalNoteCount: 1,
            globalNotePaths: ['/v/GLOBAL.md'],
            compactableGlobalNotePaths: [],
          },
        }),
      },
    })
    const text = renderDream(await executeDream(service, {}))
    expect(text).toContain('OVER BUDGET: 1800 of 1500 tokens used; compaction cannot help')
    expect(text).toContain('- /v/GLOBAL.md')
    expect(text).not.toContain('compactable least-read first')
  })

  it('renders every non-plan kind as its message', () => {
    expect(renderDream({ kind: 'dream_running', message: 'in flight' })).toBe('in flight')
    expect(renderDream({ kind: 'failed', message: 'boom' })).toBe('boom')
  })
})

describe('memory_dream definition', () => {
  // Q4 DoD: the tool description carries the usage timing and the
  // scheduling note (no system-prompt injection variant exists).
  const description = createDreamTool(createFakeService({ vaults: [] })).description

  it('carries the fixed name, 300 s budget, and run/plan presentCall cards', () => {
    const definition = createDreamTool(createFakeService({ vaults: [] }))
    expect(definition.name).toBe(TOOL_MEMORY_DREAM)
    expect(definition.timeoutMs).toBe(DREAM_TIMEOUT_MS)
    expect(definition.timeoutMs).toBe(300_000)
    expect(definition.presentCall?.({ operation: 'run' })).toMatchObject({ kind: 'execute', title: `${TOOL_MEMORY_DREAM} run` })
    expect(definition.presentCall?.({})).toMatchObject({ kind: 'other', title: `${TOOL_MEMORY_DREAM} plan` })
  })

  it('description names the use timing and the scheduling offer', () => {
    expect(description).toContain('Use at the end of significant work or when memory_audit reports the global memory budget over')
    expect(description).toContain('Automated dreaming can be scheduled: ask the user whether they want a DSH schedule or timer trigger for memory_dream (managed in the Obsidian Mem settings card)')
  })
})
