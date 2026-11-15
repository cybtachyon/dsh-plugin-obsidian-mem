/**
 * memory_dream launch-observer specs (PLAN-dream-isolation TASK-006): the
 * plugin-ctx tools/result filter matrix (tool name, error results, the
 * operation=run argument gate, the successful-launch value shape), the
 * guard answers that must NOT claim (dream_running, dream_blocked,
 * failed), plan answers, absent or poisoned values, the missing calling
 * agent, throw containment, disposer unregistration, and the
 * mountLifecycle wiring that keys the claim to the calling session.
 * @module dsh-plugin-obsidian-mem/events/tests/dreamLaunch
 */

import { afterEach, describe, expect, it } from 'vitest'

import { TOOL_MEMORY_DREAM } from '../../core/lib/index.js'
import { SessionRegistry } from '../src/sessions.ts'
import { installDreamLaunchLedger } from '../src/dreamLaunch.ts'
import { mountLifecycle } from '../src/index.ts'
import type { HookLogger, ToolExecutionMirror, ToolResultMirror } from '../src/host.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  tempDbPath,
  toolResult,
  type FakeAgent,
} from './testkit.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** The launched-run answer per the tools DreamValue union. */
function startedValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'started',
    run_id: 'run-abc',
    message: 'the dream agent is running in the background',
    ...overrides,
  }
}

interface Harness {
  ctx: ReturnType<typeof fakeEventsCtx>
  registry: SessionRegistry
  agent: FakeAgent
  /** Warnings the observer logged through its injected logger. */
  warnings: string[]
  /** Emit one tools/result; `agent: false` drops the caller from the payload. */
  fire: (
    call: { name?: string, arguments?: unknown, agent?: FakeAgent | false },
    result: ToolResultMirror,
  ) => void
  dispose: () => void
}

/** installDreamLaunchLedger alone, over a temp-backed registry. */
function harness(): Harness {
  const tmp = tempDbPath()
  cleanups.push(tmp.cleanup)
  const memory = fakeMemory({ dbPath: tmp.dir })
  const ctx = fakeEventsCtx(memory)
  const warnings: string[] = []
  const logger: HookLogger = {
    info: () => {},
    warn: (message) => { warnings.push(message) },
    debug: () => {},
  }
  const registry = new SessionRegistry({
    file: `${tmp.dir}/state/sessions.json`,
    thinkShotsPerTurn: 3,
    debounceMs: 0,
  })
  const agent = fakeAgent({ id: 'session-1' })
  const dispose = installDreamLaunchLedger({ ctx: ctx.scope as never, registry, logger })
  return {
    ctx,
    registry,
    agent,
    warnings,
    fire: (call, result) => {
      const exec: ToolExecutionMirror = {
        name: call.name ?? TOOL_MEMORY_DREAM,
        arguments: call.arguments ?? { operation: 'run' },
        ...(call.agent === false ? {} : { agent: (call.agent ?? agent) as never }),
      }
      ctx.emit('tools/result', exec, result)
    },
    dispose,
  }
}

describe('dream-launch observer claims the launcher', () => {
  it('claims the calling session for operation=run with the started value', () => {
    const h = harness()
    h.fire({}, toolResult(false, 'dream run started', startedValue()))
    expect(h.registry.isDreamLaunch('session-1')).toBe(true)
  })

  it('keys each session separately: another caller claims only itself', () => {
    const h = harness()
    const other = fakeAgent({ id: 'session-2' })
    h.fire({ agent: other }, toolResult(false, 'dream run started', startedValue()))
    expect(h.registry.isDreamLaunch('session-2')).toBe(true)
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })
})

describe('dream-launch observer non-launches', () => {
  it.each([
    ['a dream_running busy answer', startedValue({ kind: 'dream_running' })],
    ['a dream_blocked answer', startedValue({ kind: 'dream_blocked' })],
    ['a failed answer', startedValue({ kind: 'failed' })],
    ['a plan answer', { kind: 'plan', generated_at: 'x', plan: 'work plan' }],
  ])('claims nothing for %s', (_label, value) => {
    const h = harness()
    h.fire({}, toolResult(false, 'structured value', value))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('claims nothing for an error result even with the started value', () => {
    const h = harness()
    h.fire({}, toolResult(true, 'boom', startedValue()))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('claims nothing when the operation is absent or plan', () => {
    const h = harness()
    h.fire({ arguments: {} }, toolResult(false, 'plan', startedValue()))
    h.fire({ arguments: { operation: 'plan' } }, toolResult(false, 'plan', startedValue()))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('claims nothing when the result carries no value', () => {
    const h = harness()
    h.fire({}, toolResult(false, 'dream run started'))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('claims nothing for a non-memory_dream tool name', () => {
    const h = harness()
    h.fire({ name: 'read' }, toolResult(false, 'ok', startedValue()))
    h.fire({ name: 'memory_write' }, toolResult(false, 'ok', startedValue()))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('skips a payload without a calling agent silently', () => {
    const h = harness()
    h.fire({ agent: false }, toolResult(false, 'dream run started', startedValue()))
    expect(h.warnings).toEqual([])
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })
})

describe('dream-launch observer poisoned values', () => {
  it.each([
    ['null', null],
    ['an array', [startedValue()]],
    ['a string', 'started'],
    ['a number', 7],
    ['a kind-only object', { kind: 'started' }],
    ['a non-string run_id', startedValue({ run_id: 42 })],
  ])('claims nothing for %s', (_label, value) => {
    const h = harness()
    h.fire({}, toolResult(false, 'weird', value))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
    expect(h.warnings).toEqual([])
  })

  it('contains a throwing value through runGuarded (warn, no throw)', () => {
    const h = harness()
    const poisoned = {
      kind: 'started',
      get run_id(): string {
        throw new Error('poisoned getter')
      },
    }
    expect(() => {
      h.fire({}, toolResult(false, 'weird', poisoned))
    }).not.toThrow()
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
    expect(h.warnings.join('\n')).toContain('dream-launch observer failed')
  })
})

describe('dream-launch observer lifecycle', () => {
  it('stops claiming after the disposer runs', () => {
    const h = harness()
    h.dispose()
    h.fire({}, toolResult(false, 'dream run started', startedValue()))
    expect(h.registry.isDreamLaunch('session-1')).toBe(false)
  })

  it('is mounted by mountLifecycle and keyed to the created agent session', () => {
    const tmp = tempDbPath()
    cleanups.push(tmp.cleanup)
    const memory = fakeMemory({ dbPath: tmp.dir })
    const ctx = fakeEventsCtx(memory)
    const registry = mountLifecycle(ctx.scope)
    const agent = fakeAgent({ id: 'session-9' })
    ctx.emit('agent/created', agent.asCreated())
    ctx.emit(
      'tools/result',
      agent.asToolCaller(TOOL_MEMORY_DREAM, { operation: 'run' }),
      toolResult(false, 'dream run started', startedValue()),
    )
    expect(registry.isDreamLaunch('session-9')).toBe(true)
  })
})
