/**
 * memory_write observer specs (TASK-002): the plugin-ctx tools/result
 * filter matrix (tool name, error results, refusal kinds, absent or
 * poisoned values, missing calling agent), the written-ledger record
 * keyed by sourceKeyFor of the structured value, per-session keying,
 * throw containment for poisoned payloads, and disposer unregistration.
 * @module dsh-plugin-obsidian-mem/events/tests/writeLedger
 */

import { afterEach, describe, expect, it } from 'vitest'

import { SessionRegistry, sourceKeyFor } from '../src/sessions.ts'
import type { HookLogger, ToolExecutionMirror, ToolResultMirror } from '../src/host.ts'
import { installWriteLedger } from '../src/writeLedger.ts'
import { mountLifecycle } from '../src/index.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  tempDbPath,
  toolResult,
  type FakeAgent,
} from './testkit.ts'

const VAULT_PATH = '/home/test/vault'
const NOTE_PATH = `${VAULT_PATH}/topic-note.md`
const LEDGER_KEY = sourceKeyFor({ vault: VAULT_PATH, source_path: NOTE_PATH })
const WRITE_AT = 1_730_000_000_000

/** One successful memory_write value per the tools WRITE_OUTPUT schema. */
function writtenValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'written',
    path: NOTE_PATH,
    created: true,
    vault: VAULT_PATH,
    warnings: [],
    write_through: 'attempted',
    ...overrides,
  }
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!()
  }
})

interface Harness {
  ctx: ReturnType<typeof fakeEventsCtx>
  registry: SessionRegistry
  agent: FakeAgent
  /** Warnings the observer logged through its injected logger. */
  warnings: string[]
  /** Emit one tools/result; `agent: false` drops the caller from the payload. */
  fire: (
    exec: { name?: string, arguments?: unknown, agent?: FakeAgent | false },
    result: ToolResultMirror,
  ) => void
  dispose: () => void
}

/** installWriteLedger alone, over a temp-backed registry at a fixed clock. */
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
    now: () => WRITE_AT,
    debounceMs: 0,
  })
  const agent = fakeAgent({ id: 'session-1' })
  const dispose = installWriteLedger({ ctx: ctx.scope as never, registry, logger })
  return {
    ctx,
    registry,
    agent,
    warnings,
    fire: (exec, result) => {
      const payload: ToolExecutionMirror = {
        name: exec.name ?? 'memory_write',
        arguments: exec.arguments ?? {},
        ...(exec.agent === false ? {} : { agent: (exec.agent ?? agent) as never }),
      }
      ctx.emit('tools/result', payload, result)
    },
    dispose,
  }
}

describe('write-ledger observer records successful writes', () => {
  it('notes the sourceKey of a written value and stores the write time', () => {
    const h = harness()
    h.fire({}, toolResult(false, `Created memory note: ${NOTE_PATH}`, writtenValue()))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(true)
    expect(h.registry.ensure('session-1').writtenSources.get(LEDGER_KEY)).toBe(WRITE_AT)
  })

  it('records updates (created: false) exactly like new notes', () => {
    const h = harness()
    h.fire({}, toolResult(false, 'Updated', writtenValue({ created: false })))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(true)
  })

  it('keys each session separately: another agent writes its own ledger', () => {
    const h = harness()
    const other = fakeAgent({ id: 'session-2' })
    h.fire({ agent: other }, toolResult(false, 'Created', writtenValue()))
    expect(h.registry.wasWrittenIn('session-2', LEDGER_KEY)).toBe(true)
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })
})

describe('write-ledger observer refusals and non-writes', () => {
  it.each([
    'read_required',
    'stale',
    'read_only_vault',
    'outside_notes',
    'reserved_file',
    'invalid_meta',
  ])('records nothing for the %s refusal kind', (kind) => {
    const h = harness()
    h.fire({}, toolResult(false, 'refused', { kind, path: NOTE_PATH, message: 'no' }))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })

  it('records nothing for an error result even with a written-kind value', () => {
    const h = harness()
    h.fire({}, toolResult(true, 'boom', writtenValue()))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })

  it('records nothing when the result carries no value', () => {
    const h = harness()
    h.fire({}, toolResult(false, 'Created'))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })

  it('records nothing for a non-memory_write tool name', () => {
    const h = harness()
    h.fire({ name: 'read' }, toolResult(false, 'ok', writtenValue()))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })

  it('skips a payload without a calling agent', () => {
    const h = harness()
    h.fire({ agent: false }, toolResult(false, 'Created', writtenValue()))
    expect(h.warnings).toEqual([])
    // No session was even touched: the ledger answers false for every key.
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
  })
})

describe('write-ledger observer poisoned values', () => {
  it.each([
    ['null', null],
    ['an array', [writtenValue()]],
    ['a string', 'written'],
    ['a number', 7],
    ['a kind-only object', { kind: 'written' }],
    ['a non-string path', writtenValue({ path: 42 })],
    ['a non-string vault', writtenValue({ vault: {} })],
  ])('records nothing for %s', (_label, value) => {
    const h = harness()
    h.fire({}, toolResult(false, 'weird', value))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
    expect(h.warnings).toEqual([])
  })

  it('contains a throwing value through runGuarded (warn, no throw)', () => {
    const h = harness()
    const poisoned = {
      kind: 'written',
      get path(): string {
        throw new Error('poisoned getter')
      },
    }
    expect(() => {
      h.fire({}, toolResult(false, 'weird', poisoned))
    }).not.toThrow()
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
    expect(h.warnings.join('\n')).toContain('write-ledger observer failed')
  })
})

describe('write-ledger observer lifecycle', () => {
  it('stops recording after the disposer runs', () => {
    const h = harness()
    h.dispose()
    h.fire({}, toolResult(false, 'Created', writtenValue()))
    expect(h.registry.wasWrittenIn('session-1', LEDGER_KEY)).toBe(false)
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
      agent.asToolCaller('memory_write', {}),
      toolResult(false, 'Created', writtenValue()),
    )
    expect(registry.wasWrittenIn('session-9', LEDGER_KEY)).toBe(true)
  })
})
