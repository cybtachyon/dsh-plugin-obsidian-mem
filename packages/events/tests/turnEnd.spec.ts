/**
 * Memory-watch specs (TASK-010). The turn-end save/audit reminder steer is
 * removed (the completion checkpoint rides the `memory_audit` `checkpoint`
 * view; the steered checklist cost tokens), so these specs pin the one
 * turn-end survivor: the plugin-ctx `tools/result` watch that flags
 * per-turn memory_* usage keyed by the calling agent's session, skips
 * non-memory tools and agent-less executions, never throws out of the emit
 * listener, and lands in the registry flag a new turn resets. The pure
 * isTrivialTurn rule keeps its pins as the retained exported surface.
 * @module dsh-plugin-obsidian-mem/events/tests/turnEnd
 */

import { describe, expect, it } from 'vitest'

import type { HookLogger } from '../src/host.ts'
import { mountLifecycle } from '../src/index.ts'
import { SessionRegistry } from '../src/sessions.ts'
import { installMemoryToolWatch, isTrivialTurn, TRIVIAL_TURN_MAX_CHARS } from '../src/turnEnd.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  tempDbPath,
  toolResult,
  type FakeAgent,
} from './testkit.ts'

interface WatchHarness {
  registry: SessionRegistry
  warnings: string[]
  useTool: (caller: { name: string, arguments: unknown, agent?: unknown }) => void
}

/** installMemoryToolWatch on a fake plugin ctx, nothing else mounted. */
function watch(): WatchHarness {
  const tmp = tempDbPath()
  const memory = fakeMemory({ dbPath: tmp.dir })
  const ctx = fakeEventsCtx(memory)
  const registry = new SessionRegistry({
    file: `${tmp.dir}/state/sessions.json`,
    thinkShotsPerTurn: 3,
    debounceMs: 0,
  })
  const warnings: string[] = []
  const logger: HookLogger = { info: () => {}, warn: (message) => { warnings.push(message) }, debug: () => {} }
  installMemoryToolWatch({ ctx: ctx.scope as never, registry, logger })
  return {
    registry,
    warnings,
    useTool: (caller) => {
      ctx.emit('tools/result', caller, toolResult(false, 'ok'))
    },
  }
}

function caller(agent: FakeAgent, name: string): { name: string, arguments: unknown, agent: unknown } {
  return { name, arguments: {}, agent }
}

describe('memory-tool watch bookkeeping', () => {
  it('flags the calling agent session for every memory_* tool name', () => {
    for (const name of ['memory_read', 'memory_search', 'memory_write', 'memory_dream', 'memory_audit']) {
      const h = watch()
      const agent = fakeAgent({ id: 'session-1' })
      h.registry.ensure('session-1')
      h.useTool(caller(agent, name))
      expect(h.registry.memoryToolUsed('session-1'), name).toBe(true)
    }
  })

  it('other tool names do not flag the session', () => {
    const h = watch()
    const agent = fakeAgent({ id: 'session-1' })
    h.registry.ensure('session-1')
    h.useTool(caller(agent, 'read'))
    expect(h.registry.memoryToolUsed('session-1')).toBe(false)
  })

  it('keys on the calling agent, not on any single agent', () => {
    const h = watch()
    const first = fakeAgent({ id: 'session-a' })
    h.useTool(caller(first, 'memory_search'))
    expect(h.registry.memoryToolUsed('session-a')).toBe(true)
    expect(h.registry.memoryToolUsed('session-b')).toBe(false)
  })

  it('an execution with no agent is skipped without a warning', () => {
    const h = watch()
    h.useTool({ name: 'memory_search', arguments: {} })
    expect(h.warnings).toEqual([])
  })

  it('a poisoned payload never throws out of the emit listener', () => {
    const h = watch()
    expect(() => h.useTool(null as never)).not.toThrow()
    expect(h.warnings.join('\n')).toContain('memory-tool watch failed')
  })

  it('the per-turn flag resets when the registry sees a new turn', () => {
    const h = watch()
    const agent = fakeAgent({ id: 'session-1' })
    h.registry.ensure('session-1')
    h.useTool(caller(agent, 'memory_audit'))
    expect(h.registry.memoryToolUsed('session-1')).toBe(true)
    h.registry.noteTurn('session-1', 2, 'Now sweep the flaky specs under tests/api')
    expect(h.registry.memoryToolUsed('session-1')).toBe(false)
  })
})

describe('isTrivialTurn (retained exported surface, TASK-010)', () => {
  it('applies the WORK_MARKER rule at TRIVIAL_TURN_MAX_CHARS', () => {
    expect(TRIVIAL_TURN_MAX_CHARS).toBe(24)
    expect(isTrivialTurn('hi')).toBe(true)
    expect(isTrivialTurn('thanks!')).toBe(true)
    expect(isTrivialTurn('')).toBe(true)
    expect(isTrivialTurn('a'.repeat(24))).toBe(true) // at the cap, no marker
    expect(isTrivialTurn('a'.repeat(25))).toBe(false)
    expect(isTrivialTurn('look at /tmp please')).toBe(false) // path marker
    expect(isTrivialTurn('fix the `spec.ts` run')).toBe(false) // code tick
    expect(isTrivialTurn('C:\\dsh\\logs path')).toBe(false) // windows separator
  })
})

describe('mount wiring', () => {
  it('the mounted watch flags the session through the plugin ctx', () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir })
    const ctx = fakeEventsCtx(memory)
    const registry = mountLifecycle(ctx.scope)
    const agent = fakeAgent({ id: 'session-wired' })
    ctx.emit('agent/created', agent.asCreated())
    ctx.emit('tools/result', agent.asToolCaller('memory_write', {}), toolResult(false, 'ok'))
    expect(registry.memoryToolUsed('session-wired')).toBe(true)
  })
})
