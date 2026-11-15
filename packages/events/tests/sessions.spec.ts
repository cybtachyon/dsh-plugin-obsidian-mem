import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ServiceFs } from '../../service/lib/index.js'
import { nodeServiceFs } from '../../service/lib/index.js'
import {
  READ_INJECTION_CAP_PER_SESSION,
  READ_INJECTION_THROTTLE_MS,
  SessionRegistry,
} from '../src/sessions.ts'

/**
 * SessionRegistry specs (TASK-040): the once-per-session injection rule
 * (including restart persistence and changed-note re-eligibility), subagent
 * separation, the Think budget reset on a new turn, the Read-intercept
 * throttle/cap/dir-coverage state, the recall token accounting, the
 * post-compaction recall rebaseline (TASK-001), and the LRU/TTL-bounded
 * atomic ledger.
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
    debounceMs: 0,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
}

/**
 * A ServiceFs that delegates to the node seam and tallies writeFile calls
 * (every persistNow writes exactly one tmp file), for persist-silence specs.
 */
function countingFs(): ServiceFs & { writes: number } {
  const spy: ServiceFs & { writes: number } = {
    writes: 0,
    exists: (path) => nodeServiceFs.exists(path),
    realpath: (path) => nodeServiceFs.realpath(path),
    mkdirp: (path) => nodeServiceFs.mkdirp(path),
    readFile: (path) => nodeServiceFs.readFile(path),
    writeFile: (path, contents) => {
      spy.writes += 1
      nodeServiceFs.writeFile(path, contents)
    },
    rename: (from, to) => nodeServiceFs.rename(from, to),
    unlink: (path) => nodeServiceFs.unlink(path),
    stat: (path) => nodeServiceFs.stat(path),
  }
  return spy
}

describe('once-per-session injection rule', () => {
  it('injects a source once: second ask is refused', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    expect(registry.shouldInject('s1', 'vaultA\u0000a.md')).toBe(true)
    registry.markInjected('s1', 'vaultA\u0000a.md')
    expect(registry.shouldInject('s1', 'vaultA\u0000a.md')).toBe(false)
    // A different session keeps its own ledger.
    expect(registry.shouldInject('s2', 'vaultA\u0000a.md')).toBe(true)
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

describe('dream-lineage flag (PLAN-dream-isolation TASK-003)', () => {
  it('defaults false, is set on ensure, and stays sticky across later ensures', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    // Default false, and answering never disturbs the sibling flag.
    expect(registry.isDreamLineage('s1')).toBe(false)
    expect(registry.isSubagent('s1')).toBe(false)
    registry.ensure('s1', { dreamLineage: true })
    expect(registry.isDreamLineage('s1')).toBe(true)
    // A later ensure without the claim (or with false) cannot clear it.
    registry.ensure('s1')
    expect(registry.isDreamLineage('s1')).toBe(true)
    registry.ensure('s1', { dreamLineage: false })
    expect(registry.isDreamLineage('s1')).toBe(true)
    // dreamLineage never implies subagent, and one session never colors another.
    expect(registry.isSubagent('s1')).toBe(false)
    expect(registry.isDreamLineage('s2')).toBe(false)
  })

  it('never touches the ledger: no persist, no dreamLineage key in sessions.json', () => {
    const { file } = tempFile()
    const fs = countingFs()
    const registry = new SessionRegistry({ file, thinkShotsPerTurn: 3, debounceMs: 0, fs })
    // The claim alone writes nothing to disk.
    registry.ensure('dream', { dreamLineage: true })
    expect(fs.writes).toBe(0)
    // An unrelated ledger mutation now persists the row; the flag stays out.
    registry.markInjected('dream', 'vaultA\u0000a.md')
    registry.flush()
    expect(registry.isDreamLineage('dream')).toBe(true)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, Record<string, unknown>>
    }
    expect(saved.sessions.dream).not.toHaveProperty('dreamLineage')
    expect(Object.keys(saved.sessions.dream!).sort()).toEqual(
      ['createdAt', 'injected', 'subagent', 'updatedAt', 'written'],
    )
    // Subagent, the ledger-carrying sibling of the same pattern, does persist.
    expect(saved.sessions.dream?.subagent).toBe(false)
  })

  it('hydrates false after a restart over the same sessions.json', () => {
    const { file } = tempFile()
    const first = makeRegistry(file)
    first.ensure('dream', { dreamLineage: true })
    first.markInjected('dream', 'note', 'fp')
    first.flush()
    // The live flag died with the process; the ledger row survived.
    const second = makeRegistry(file)
    expect(second.isDreamLineage('dream')).toBe(false)
    expect(second.shouldInject('dream', 'note', 'fp')).toBe(false)
  })

  it('answers for an unseen session without creating a stray ledger row', () => {
    const { file } = tempFile()
    const fs = countingFs()
    const registry = new SessionRegistry({ file, thinkShotsPerTurn: 3, debounceMs: 0, fs })
    expect(registry.isDreamLineage('ghost')).toBe(false)
    // The ensure behind the accessor is read-side only: no write, no file.
    expect(fs.writes).toBe(0)
    expect(existsSync(file)).toBe(false)
  })
})

describe('dream-launch flag (PLAN-dream-isolation TASK-006)', () => {
  it('claims through markDreamLaunch, answers per session, and never touches the ledger', () => {
    const { file } = tempFile()
    const fs = countingFs()
    const registry = new SessionRegistry({ file, thinkShotsPerTurn: 3, debounceMs: 0, fs })
    expect(registry.isDreamLaunch('s1')).toBe(false)
    registry.markDreamLaunch('s1')
    expect(registry.isDreamLaunch('s1')).toBe(true)
    expect(registry.isDreamLaunch('s2')).toBe(false)
    // Live-only like dreamLineage: the claim alone writes nothing.
    expect(fs.writes).toBe(0)
    // A later ledger mutation persists the row; the flag stays out.
    registry.markInjected('s1', 'vaultA\u0000a.md')
    registry.flush()
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, Record<string, unknown>>
    }
    expect(saved.sessions.s1).not.toHaveProperty('dreamLaunch')
    expect(saved.sessions.s1).not.toHaveProperty('dreamLineage')
  })

  it('hydrates false after a restart: the launch window died with the process', () => {
    const { file } = tempFile()
    const first = makeRegistry(file)
    first.markDreamLaunch('launcher')
    first.markInjected('launcher', 'note', 'fp')
    first.flush()
    const second = makeRegistry(file)
    expect(second.isDreamLaunch('launcher')).toBe(false)
    expect(second.shouldInject('launcher', 'note', 'fp')).toBe(false)
  })
})

describe('written-source ledger (mem-loop-tuning TASK-001)', () => {
  it('records a written source and answers membership per session', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    expect(registry.wasWrittenIn('s1', 'vaultA\u0000a.md')).toBe(false)
    registry.noteWrittenSource('s1', 'vaultA\u0000a.md')
    expect(registry.wasWrittenIn('s1', 'vaultA\u0000a.md')).toBe(true)
    // A different session keeps its own ledger (subagents included).
    expect(registry.wasWrittenIn('s2', 'vaultA\u0000a.md')).toBe(false)
  })

  it('persists the ledger for a fresh registry over the same sessions.json', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const first = makeRegistry(file, { now: clock.now })
    first.noteWrittenSource('s1', 'vaultA\u0000a.md')
    first.noteWrittenSource('s1', 'vaultA\u0000b.md', 1_234)
    first.flush()

    const second = makeRegistry(file, { now: clock.now })
    expect(second.wasWrittenIn('s1', 'vaultA\u0000a.md')).toBe(true)
    expect(second.wasWrittenIn('s1', 'vaultA\u0000b.md')).toBe(true)
    // The write times survived; the clock default and the explicit `at`.
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { written: Record<string, number> }>
    }
    expect(saved.sessions.s1?.written).toEqual({
      'vaultA\u0000a.md': clock.now(),
      'vaultA\u0000b.md': 1_234,
    })
  })

  it('answers false for an unknown key after hydration', () => {
    const { file } = tempFile()
    const first = makeRegistry(file)
    first.noteWrittenSource('s1', 'vaultA\u0000a.md')
    first.flush()
    const second = makeRegistry(file)
    expect(second.wasWrittenIn('s1', 'vaultA\u0000unknown.md')).toBe(false)
    expect(second.wasWrittenIn('unseen-session', 'vaultA\u0000a.md')).toBe(false)
  })

  it('prunes the written ledger with the session on TTL and LRU eviction', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now, maxSessions: 2 })
    // LRU: three live sessions, the least-recently-touched goes first.
    registry.noteWrittenSource('a', 'note')
    clock.advance(1_000)
    registry.noteWrittenSource('b', 'note')
    clock.advance(1_000)
    registry.noteWrittenSource('c', 'note')
    registry.flush()

    let saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { written: Record<string, number> }>
    }
    expect(Object.keys(saved.sessions).sort()).toEqual(['b', 'c'])
    expect(registry.wasWrittenIn('a', 'note')).toBe(false)

    // TTL: the whole store ages past the 30-day bound; only a fresh touch stays.
    clock.advance(31 * 24 * 60 * 60 * 1000)
    registry.noteWrittenSource('fresh', 'note')
    registry.flush()
    saved = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { written: Record<string, number> }>
    }
    expect(Object.keys(saved.sessions)).toEqual(['fresh'])
    expect(registry.wasWrittenIn('b', 'note')).toBe(false)

    const reopened = makeRegistry(file, { now: clock.now })
    expect(reopened.wasWrittenIn('fresh', 'note')).toBe(true)
    expect(reopened.wasWrittenIn('a', 'note')).toBe(false)
  })

  it('treats a ledger row without a written map as empty', () => {
    const { dir, file } = tempFile()
    mkdirSync(dir, { recursive: true })
    // A pre-TASK-001 v1 row: no `written` key at all.
    const stamp = Date.now()
    writeFileSync(file, `${JSON.stringify({
      version: 1,
      sessions: {
        s1: { injected: { note: { at: stamp } }, subagent: false, createdAt: stamp, updatedAt: stamp },
      },
    })}\n`, 'utf8')
    const registry = makeRegistry(file)
    expect(registry.wasWrittenIn('s1', 'note')).toBe(false)
    // The injection ledger still hydrates from the same row.
    expect(registry.shouldInject('s1', 'note')).toBe(false)
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

  it('rebases the cap live through setThinkShotsPerTurn (TASK-004)', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file, { thinkShotsPerTurn: 1 })
    expect(registry.consumeThinkShot('s1')).toBe(true)
    expect(registry.consumeThinkShot('s1')).toBe(false)
    // A raise applies immediately; the spent shot of the turn stays spent.
    registry.setThinkShotsPerTurn(3)
    expect(registry.thinkBudgetLeft('s1')).toBe(2)
    expect(registry.consumeThinkShot('s1')).toBe(true)
    // A lower cap bites at once: budget floors at 0, never negative.
    registry.setThinkShotsPerTurn(1)
    expect(registry.thinkBudgetLeft('s1')).toBe(0)
    expect(registry.consumeThinkShot('s1')).toBe(false)
    // Non-integer input truncates; non-finite input keeps the current cap.
    registry.setThinkShotsPerTurn(2.9)
    expect(registry.thinkBudgetLeft('s2')).toBe(2)
    registry.setThinkShotsPerTurn(Number.NaN)
    expect(registry.thinkBudgetLeft('s2')).toBe(2)
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

describe('recall usage rebaseline (TASK-001)', () => {
  it('zeroes every live session counter and drops the total to 0', () => {
    const { file } = tempFile()
    const registry = makeRegistry(file)
    registry.addRecallTokens('s1', 100)
    registry.addRecallTokens('s2', 50)
    registry.resetRecallUsage()
    expect(registry.recallTokensUsed('s1')).toBe(0)
    expect(registry.recallTokensUsed('s2')).toBe(0)
    expect(registry.totalRecallTokensUsed()).toBe(0)
    // Accounting restarts from zero.
    registry.addRecallTokens('s1', 7)
    expect(registry.totalRecallTokensUsed()).toBe(7)
  })

  it('leaves the injected-sources ledger and the throttle state untouched', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now })
    registry.markInjected('s1', 'vaultA\u0000a.md', 'fp')
    registry.noteReadInjection('s1', '/work/src')
    registry.consumeThinkShot('s1')
    registry.noteWakeTerms('s1', ['alpha'])
    registry.resetRecallUsage()
    expect(registry.shouldInject('s1', 'vaultA\u0000a.md', 'fp')).toBe(false)
    expect(registry.readThrottleActive('s1')).toBe(true)
    expect(registry.readCapLeft('s1')).toBe(true)
    expect(registry.readDirCovered('s1', '/work/src')).toBe(true)
    expect(registry.thinkBudgetLeft('s1')).toBe(2)
    expect([...registry.wakeTermsFor('s1')]).toEqual(['alpha'])
  })

  it('triggers no persist call on its own', () => {
    const { file } = tempFile()
    const fs = countingFs()
    const registry = new SessionRegistry({ file, thinkShotsPerTurn: 3, debounceMs: 0, fs })
    registry.markInjected('s1', 'note')
    // Baseline: a ledger mutation with debounceMs 0 writes synchronously.
    expect(fs.writes).toBeGreaterThan(0)
    const baseline = fs.writes
    registry.addRecallTokens('s1', 120)
    registry.resetRecallUsage()
    expect(fs.writes).toBe(baseline)
  })
})

describe('sessions.json persistence', () => {
  it('drops TTL-expired sessions and caps the file at the LRU bound', () => {
    const { file } = tempFile()
    const clock = fakeClock()
    const registry = makeRegistry(file, { now: clock.now, maxSessions: 2 })
    registry.markInjected('old', 'note')
    clock.advance(31 * 24 * 60 * 60 * 1000)
    // Three survivors so the TTL prune leaves the store OVER the cap and
    // the LRU eviction actually runs (two survivors would sit at the cap).
    registry.markInjected('mid', 'note')
    clock.advance(1_000)
    registry.markInjected('new', 'note')
    clock.advance(1_000)
    registry.markInjected('newer', 'note')
    registry.flush()

    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      sessions: Record<string, { injected: Record<string, unknown> }>
    }
    // 'old' is past the 30-day TTL; 'mid' is the LRU victim of the cap of 2.
    expect(Object.keys(saved.sessions).sort()).toEqual(['new', 'newer'])
    expect(saved.version).toBe(1)
    // In-memory records followed both prunes.
    expect(registry.shouldInject('old', 'note')).toBe(true)
    expect(registry.shouldInject('mid', 'note')).toBe(true)
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
