import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  READ_INJECTION_CAP_PER_SESSION,
  READ_INJECTION_THROTTLE_MS,
  SessionRegistry,
} from '../src/sessions.ts'

/**
 * SessionRegistry specs (TASK-040): the once-per-session injection rule
 * (including restart persistence and changed-note re-eligibility), subagent
 * separation, the Think budget reset on a new turn, the Read-intercept
 * throttle/cap/dir-coverage state, and the LRU/TTL-bounded atomic ledger.
 */

const cleanups: Array<() => void> = []

function tempFile(name = 'sessions.json'): { dir: string, file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-mem-sessions-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return { dir, file: join(dir, name) }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** A controllable clock; every registry seam takes `now`. */
function fakeClock(start = 1_700_000_000_000): { now: () => number, advance(ms: number): void } {
  let current = start
  return {
    now: () => current,
    advance(ms: number) { current += ms },
  }
}

function makeRegistry(
  file: string,
  options: {
    now?: () => number
    maxSessions?: number
    thinkShotsPerTurn?: number
    log?: (message: string) => void
  } = {},
): SessionRegistry {
  return new SessionRegistry({
    file,
    thinkShotsPerTurn: options.thinkShotsPerTurn ?? 3,
    now: options.now,
    maxSessions: options.maxSessions,
    debounceMs: 0,
    log: options.log,
  })
}

describe('once-per-session injection rule', () => {
  it('injects a source once: second ask is refused', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    expect(registry.shouldInject('s1', 'vaultA\u0000markdown/a.md')).toBe(true)
    registry.markInjected('s1', 'vaultA\u0000markdown/a.md')
    expect(registry.shouldInject('s1', 'vaultA\u0000markdown/a.md')).toBe(false)
    // A different session keeps its own ledger.
    expect(registry.shouldInject('s2', 'vaultA\u0000markdown/a.md')).toBe(true)
  })

  it('re-admits a source whose content fingerprint changed after injection', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    registry.markInjected('s1', 'note', 'hash-1')
    expect(registry.shouldInject('s1', 'note', 'hash-1')).toBe(false)
    expect(registry.shouldInject('s1', 'note', 'hash-2')).toBe(true)
    // The unknown-fingerprint case (no fingerprint stored) stays refused.
    registry.markInjected('s1', 'plain')
    expect(registry.shouldInject('s1', 'plain', 'whatever')).toBe(false)
  })

  it('honors the rule across a restart via the persisted ledger', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const first = makeRegistry(file, { now: clock.now })
    first.markInjected('s1', 'note', 'fp')
    first.flush()

    const second = makeRegistry(file, { now: clock.now })
    expect(second.shouldInject('s1', 'note', 'fp')).toBe(false)
    // The fingerprint survived too: the note was unchanged, so still refused;
    // a changed note is eligible again even after the restart.
    expect(second.shouldInject('s1', 'note', 'fp-changed')).toBe(true)
  })

  it('keeps subagents as separate sessions', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    registry.ensure('parent', { subagent: false })
    registry.ensure('child', { subagent: true })
    registry.markInjected('parent', 'note')
    expect(registry.shouldInject('child', 'note')).toBe(true)
    expect(registry.isSubagent('child')).toBe(true)
    expect(registry.isSubagent('parent')).toBe(false)
  })
})

describe('think budget (TASK-043 input)', () => {
  it('caps shots per turn and resets when a new turn appears', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file, { thinkShotsPerTurn: 2 })
    expect(registry.consumeThinkShot('s1')).toBe(true)
    expect(registry.consumeThinkShot('s1')).toBe(true)
    expect(registry.consumeThinkShot('s1')).toBe(false)
    expect(registry.thinkBudgetLeft('s1')).toBe(0)
    registry.noteTurn('s1', 2)
    expect(registry.thinkBudgetLeft('s1')).toBe(2)
    expect(registry.consumeThinkShot('s1')).toBe(true)
  })
})

describe('read-intercept throttle state (TASK-042 input)', () => {
  it('throttles the second injection inside the window', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now })
    expect(registry.readThrottleActive('s1')).toBe(false)
    registry.noteReadInjection('s1', '/work/src')
    expect(registry.readThrottleActive('s1')).toBe(true)
    expect(registry.readDirCovered('s1', '/work/src')).toBe(true)
    expect(registry.readDirCovered('s1', '/work/test')).toBe(false)
    clock.advance(READ_INJECTION_THROTTLE_MS)
    expect(registry.readThrottleActive('s1')).toBe(false)
  })

  it('enforces the session cap independent of the think budget', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now })
    for (let i = 0; i < READ_INJECTION_CAP_PER_SESSION; i += 1) {
      expect(registry.readCapLeft('s1')).toBe(true)
      registry.noteReadInjection('s1', `/work/dir-${i}`)
      clock.advance(READ_INJECTION_THROTTLE_MS)
    }
    expect(registry.readCapLeft('s1')).toBe(false)
  })

  it('dedupes read paths within a turn and clears them on the next', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    expect(registry.readPathSeen('s1', '/work/a.ts')).toBe(false)
    expect(registry.readPathSeen('s1', '/work/a.ts')).toBe(true)
    registry.noteTurn('s1', 2)
    expect(registry.readPathSeen('s1', '/work/a.ts')).toBe(false)
  })
})

describe('recall token accounting (TASK-045 input)', () => {
  it('tracks per-session use and sums across sessions', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    registry.addRecallTokens('s1', 100)
    registry.addRecallTokens('s2', 50)
    registry.addRecallTokens('s2', -10)
    expect(registry.recallTokensUsed('s1')).toBe(100)
    expect(registry.recallTokensUsed('s2')).toBe(50)
    expect(registry.totalRecallTokensUsed()).toBe(150)
  })
})

describe('sessions.json persistence', () => {
  it('drops TTL-expired sessions and caps the file at the LRU bound', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now, maxSessions: 2 })
    registry.markInjected('old', 'note')
    clock.advance(31 * 24 * 60 * 60 * 1000)
    registry.markInjected('mid', 'note')
    clock.advance(1_000)
    registry.markInjected('new', 'note')
    registry.flush()

    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      sessions: Record<string, { injected: Record<string, unknown> }>
    }
    // 'old' is past the 30-day TTL; 'mid' is outlive by the cap of 2.
    expect(Object.keys(saved.sessions).sort()).toEqual(['mid', 'new'])
    expect(saved.version).toBe(1)
    // In-memory records followed the prune.
    expect(registry.shouldInject('old', 'note')).toBe(true)
  })

  it('treats a corrupt ledger as empty and warns', () => {
    const { dir, file } = tempFile()
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{not json', 'utf8')
    const warnings: string[] = []
    const registry = makeRegistry(file, { log: (message) => warnings.push(message) })
    expect(registry.shouldInject('s1', 'note')).toBe(true)
    expect(warnings.join('\n')).toContain('sessions.json unreadable')
  })

  it('keeps the persisted ledger when a live session is disposed', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    registry.markInjected('s1', 'note', 'fp')
    registry.flush()
    registry.disposeSession('s1')
    // Live state is gone; the ledger row is still written by the next flush.
    registry.flush()
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { injected: Record<string, unknown> }>
    }
    expect(Object.keys(saved.sessions)).toEqual(['s1'])
    // A later resume of the same id still honors the rule.
    expect(registry.shouldInject('s1', 'note', 'fp')).toBe(false)
  })

  it('writes atomically through a temp file (no leftover tmp after flush)', () => {
    const { dir, file } = tempFile()
    const registry = makeRegistry(file)
    registry.markInjected('s1', 'note')
    registry.flush()
    expect(readFileSync(file, 'utf8')).toContain('"note"')
    expect(existsSync(join(dir, 'sessions.json.obsidian-mem.tmp'))).toBe(false)
  })
})
