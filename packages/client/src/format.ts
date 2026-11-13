/**
 * Pure display logic for the card: string truncation (long vault paths and
 * chunk texts never overflow the card), count and age formatting, the local
 * calendar date the failed-dream banner dates with, the budget
 * meter's percent math, and the schedule-slug rule the Dreaming add form uses
 * to derive a trigger id from its label. Everything here is a total function
 * the vitest specs cover directly; nothing touches fetch, DOM, or react.
 * @module dsh-plugin-obsidian-mem/client/format
 */

/** TruncateLong truncates to `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) {
    return text
  }
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`
}

/** FormatCount renders an integer with thin-free thousands separators. */
export function formatCount(value: number): string {
  const digits = String(Math.trunc(value))
  const sign = digits.startsWith('-') ? '-' : ''
  const body = sign ? digits.slice(1) : digits
  return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** FormatBytes renders a byte count as the nearest human unit. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * FormatAge renders an epoch-ms stamp relative to `nowMs`: "never" for null,
 * "just now" under a minute, then whole minutes, hours, and days. A stamp in
 * the future reads "just now" (a skewed clock never renders a negative age).
 */
export function formatAge(epochMs: number | null, nowMs: number): string {
  if (epochMs === null || !Number.isFinite(epochMs)) {
    return 'never'
  }
  const delta = nowMs - epochMs
  if (delta < MINUTE_MS) {
    return 'just now'
  }
  if (delta < HOUR_MS) {
    return `${String(Math.floor(delta / MINUTE_MS))} min ago`
  }
  if (delta < DAY_MS) {
    return `${String(Math.floor(delta / HOUR_MS))} h ago`
  }
  return `${String(Math.floor(delta / DAY_MS))} d ago`
}

/**
 * FormatLocalDate renders an epoch-ms stamp as the local calendar date
 * "YYYY-MM-DD" (zero-padded). A hand-built date instead of
 * toLocaleDateString: the copy stays stable across host locales and the
 * specs assert it literally.
 */
export function formatLocalDate(epochMs: number): string {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * BudgetPercent clamps used/budget to a 0..100 meter percent. A non-positive
 * budget (or a non-finite ratio) reads 0: the meter never divides by zero and
 * never overflows its track; the over-budget state carries itself.
 */
export function budgetPercent(used: number, budget: number): number {
  if (!(budget > 0) || !Number.isFinite(used)) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)))
}

/**
 * SlugId derives a dreaming-trigger id from a label under the route's slug
 * rule ([a-z0-9][a-z0-9._-]{0,63}): lower-cased, every run of other
 * characters collapsed to one '-', leading separators dropped, capped at 64.
 * An empty result falls back to 'dream'.
 */
export function slugId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 64)
  return slug === '' ? 'dream' : slug
}

/**
 * ClampTopK bounds the search panel's topK input to 1..10 (the route clamps
 * to 10 too; the card clamps first so the field and the request agree).
 */
export function clampTopK(raw: string): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) {
    return 10
  }
  return Math.min(10, Math.max(1, value))
}
