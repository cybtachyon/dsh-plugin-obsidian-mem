/**
 * The Dreaming section's pure banner logic: the failed-last-run warning copy
 * (banner text, detail choice, and the silent no-run / success cases), with
 * its local finished-date stamp. No DOM, no fetch, no react.
 * @module dsh-plugin-obsidian-mem/client/tests/dreaming
 */

import { describe, expect, it } from 'vitest'

import type { DreamRunSummary } from '../../service/lib/dream.js'
import { lastRunFailureText } from '../src/sections/dreaming.tsx'

/** A recorded-run fixture; the banner reads ok, error, summary, and finishedAt. */
function runFixture(overrides: Partial<DreamRunSummary> = {}): DreamRunSummary {
  return {
    id: 'run-1',
    startedAt: 1_700_000_000_000,
    // Local noon: the date half is 2026-11-12 in every zone.
    finishedAt: new Date(2026, 10, 12, 12, 0, 0).getTime(),
    ok: false,
    notes: 0,
    bumped: 0,
    degraded: 0,
    archiveCandidates: [],
    summary: 'dream run failed: dream agent turn failed: model unavailable',
    error: 'dream agent turn failed: model unavailable',
    ...overrides,
  }
}

describe('lastRunFailureText', () => {
  it('stays silent with no recorded run or a successful run', () => {
    expect(lastRunFailureText(null)).toBeNull()
    expect(lastRunFailureText(runFixture({ ok: true }))).toBeNull()
  })

  it('names the raw error and the local finished date on a failed run', () => {
    expect(lastRunFailureText(runFixture())).toBe(
      'Last dream run failed (2026-11-12): dream agent turn failed: model unavailable',
    )
  })

  it('falls back to the summary line when the host recorded no error', () => {
    expect(lastRunFailureText(runFixture({ error: null, summary: 'dream run failed: unknown error' }))).toBe(
      'Last dream run failed (2026-11-12): dream run failed: unknown error',
    )
  })
})
