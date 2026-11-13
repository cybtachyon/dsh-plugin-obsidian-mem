/**
 * Pure display-logic tests for the card's format module: truncation,
 * counting, age, budget-meter math, the schedule-slug rule, and the search
 * topK clamp. No DOM, no fetch, no react.
 * @module dsh-plugin-obsidian-mem/client/tests/format
 */

import { describe, expect, it } from 'vitest'

import {
  budgetPercent,
  clampTopK,
  formatAge,
  formatBytes,
  formatCount,
  formatLocalDate,
  slugId,
  truncate,
} from '../src/format.ts'

describe('truncate', () => {
  it('keeps short text and marks the cut on long text', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('exactly!', 8)).toBe('exactly!')
    expect(truncate('abcdefghij', 5)).toBe('abcd\u2026')
    expect(truncate('abc', 0)).toBe('abc')
  })
})

describe('formatCount / formatBytes', () => {
  it('groups thousands without touching sign or small values', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1_000)).toBe('1,000')
    expect(formatCount(1_234_567)).toBe('1,234,567')
    expect(formatCount(-2_500)).toBe('-2,500')
  })

  it('renders bytes at the nearest unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
  })
})

describe('formatAge', () => {
  const now = 1_700_000_000_000
  it('renders never, just now, minutes, hours, and days', () => {
    expect(formatAge(null, now)).toBe('never')
    expect(formatAge(now + 5_000, now)).toBe('just now')
    expect(formatAge(now - 30_000, now)).toBe('just now')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 d ago')
  })
})

describe('formatLocalDate', () => {
  // Anchored at local noon so the calendar date is the same in every zone.
  it('renders the local calendar date zero-padded', () => {
    expect(formatLocalDate(new Date(2026, 10, 12, 12).getTime())).toBe('2026-11-12')
    expect(formatLocalDate(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05')
    expect(formatLocalDate(new Date(2025, 8, 30, 12).getTime())).toBe('2025-09-30')
  })
})

describe('budgetPercent', () => {
  it('clamps to the 0..100 meter and guards a zero budget', () => {
    expect(budgetPercent(0, 0)).toBe(0)
    expect(budgetPercent(500, 0)).toBe(0)
    expect(budgetPercent(500, 1_500)).toBe(33)
    expect(budgetPercent(2_000, 1_500)).toBe(100)
    expect(budgetPercent(-10, 1_500)).toBe(0)
    expect(budgetPercent(Number.NaN, 1_500)).toBe(0)
  })
})

describe('slugId', () => {
  it('derives route-safe ids from labels', () => {
    expect(slugId('Nightly Tidy')).toBe('nightly-tidy')
    expect(slugId('  Weekdays @ 3am! ')).toBe('weekdays-3am')
    expect(slugId('***')).toBe('dream')
    expect(slugId('a'.repeat(100)).length).toBeLessThanOrEqual(64)
    expect(slugId('Deep Review v2')).toBe('deep-review-v2')
  })
})

describe('clampTopK', () => {
  it('bounds the search panel input to 1..10', () => {
    expect(clampTopK('5')).toBe(5)
    expect(clampTopK('0')).toBe(1)
    expect(clampTopK('999')).toBe(10)
    expect(clampTopK('nonsense')).toBe(10)
  })
})
