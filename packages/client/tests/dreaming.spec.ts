/**
 * The Dreaming section's pure logic: the failed-last-run warning copy
 * (banner text, detail choice, and the silent no-run / success cases), with
 * its local finished-date stamp, and the add-trigger form validator (accept
 * and reject paths). No DOM, no fetch, no react.
 * @module dsh-plugin-obsidian-mem/client/tests/dreaming
 */

import { describe, expect, it } from 'vitest'

import type { DreamRunSummary } from '../../service/lib/dream.js'
import { lastRunFailureText, validateScheduleForm } from '../src/sections/dreaming.tsx'

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

/** A submittable form fixture; each case varies the one field under test. */
function scheduleForm(overrides: Partial<Parameters<typeof validateScheduleForm>[0]> = {}) {
  return {
    label: 'nightly',
    expression: '0 3 * * *',
    everySeconds: '',
    sessionId: 'session-1',
    ...overrides,
  }
}

describe('validateScheduleForm', () => {
  it('accepts a labeled cron trigger naming a wake session', () => {
    expect(validateScheduleForm(scheduleForm())).toBeNull()
  })

  it('accepts a labeled fixed-interval trigger at the 60-second floor', () => {
    expect(validateScheduleForm(scheduleForm({ expression: '', everySeconds: '60' }))).toBeNull()
  })

  it('rejects a blank label', () => {
    expect(validateScheduleForm(scheduleForm({ label: '' }))).toBe('Give the trigger a label.')
  })

  it('rejects a form with neither timing nor both', () => {
    const neither = 'Give exactly one timing: a cron expression or a fixed interval in seconds.'
    expect(validateScheduleForm(scheduleForm({ expression: '', everySeconds: '' }))).toBe(neither)
    expect(validateScheduleForm(scheduleForm({ everySeconds: '120' }))).toBe(neither)
  })

  it('rejects an interval below 60 or not a whole number', () => {
    const message = 'The fixed interval must be a whole number of seconds, at least 60.'
    expect(validateScheduleForm(scheduleForm({ expression: '', everySeconds: '59' }))).toBe(message)
    expect(validateScheduleForm(scheduleForm({ expression: '', everySeconds: 'abc' }))).toBe(message)
  })

  it('rejects a form that names no wake session', () => {
    expect(validateScheduleForm(scheduleForm({ sessionId: '' }))).toBe(
      'Name the session this trigger should wake (the schedule service needs one).',
    )
  })
})
