/**
 * Models the memory-note Markdown format: NoteMeta frontmatter fields,
 * tolerant parsing, stable-order serialization, meta validation split into
 * errors versus warnings, title-to-filename slugs, archive detection, and
 * the Why:/How to apply: body discipline warnings.
 *
 * Pure text transforms over gray-matter; no fs, no env, no @deepseek-ai
 * imports. Notes are files only through their callers.
 * @module dsh-plugin-obsidian-mem/core/note
 */

import matter from 'gray-matter'
import { isScopeType, SCOPE_GLOBAL } from './constants.js'

/** A registered memory: frontmatter meta plus Markdown body. */
export interface Note {
  meta: NoteMeta
  body: string
}

/**
 * NoteMeta is the frontmatter contract every indexed note carries.
 * index_title follows the "Topic: Scenario" discipline; index_description
 * is the recall hook that decides whether to open the note; type is a named
 * scope or a project slug; archive retires the note from search defaults
 * and reindexing; read stats (last_read_at, read_count) drive dreaming.
 */
export interface NoteMeta {
  index_title: string
  index_description: string
  type: string
  archive: boolean
  /** ISO 8601 timestamp or date; '' when unknown. */
  created: string
  /** ISO 8601 timestamp or date; '' when unknown. */
  updated: string
  /** ISO 8601 date of the last recall read; absent when never read. */
  last_read_at?: string
  read_count: number
}

/** Soft ceiling for index_description; longer text warns, never errors. */
export const MAX_INDEX_DESCRIPTION_CHARS = 120

// Normalized line-start match for the body discipline lines. Accepts bold
// (`**Why:**`), list bullets, and the CJK full-width colon the engramory
// doctor also tolerates.
const WHY_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?Why(?:\*\*)?\s*[:：]/im
const HOW_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?How to apply(?:\*\*)?\s*[:：]/im

// ISO 8601 date, optionally followed by a time and offset. Calendar
// validity is checked separately by a Date.UTC round-trip.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/

/** The outcome of validating note meta; empty arrays mean valid. */
export interface MetaValidation {
  errors: string[]
  warnings: string[]
}

/**
 * parseNote splits a note into meta and body, applying defaults for missing
 * fields (archive false, read_count 0, type global, empty strings) and
 * coercing YAML-parsed dates back to ISO text. It tolerates absent fields
 * and absent frontmatter, but malformed YAML throws from gray-matter:
 * a corrupt file is an audit finding, not something to reinterpret.
 */
export function parseNote(text: string): Note {
  const normalized = text.replace(/\r\n?/g, '\n')
  const parsed = matter(normalized)
  const data = (parsed.data ?? {}) as Record<string, unknown>

  const lastReadAt = stampOf(data['last_read_at'])
  const meta: NoteMeta = {
    index_title: textOf(data['index_title']),
    index_description: textOf(data['index_description']),
    type: textOf(data['type']) || SCOPE_GLOBAL,
    archive: boolOf(data['archive']),
    created: stampOf(data['created']),
    updated: stampOf(data['updated']),
    ...(lastReadAt === '' ? {} : { last_read_at: lastReadAt }),
    read_count: countOf(data['read_count']),
  }
  return { meta, body: parsed.content }
}

/**
 * serializeNote renders {meta, body} back to note text: frontmatter keys in
 * one stable order (index_title, index_description, type, archive, created,
 * updated, last_read_at, read_count), CRLF collapsed to LF, body ending in
 * exactly one newline. Optional timestamps are omitted when empty, so a
 * re-serialize of untouched content is byte-identical.
 */
export function serializeNote(note: Note): string {
  const { meta, body } = note
  const ordered = {
    index_title: meta.index_title,
    index_description: meta.index_description,
    type: meta.type,
    archive: meta.archive,
    ...(meta.created === '' ? {} : { created: meta.created }),
    ...(meta.updated === '' ? {} : { updated: meta.updated }),
    ...(meta.last_read_at ? { last_read_at: meta.last_read_at } : {}),
    read_count: meta.read_count,
  }
  const trimmed = body.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const normalized = trimmed === '' ? '' : `${trimmed}\n`
  return matter.stringify(normalized, ordered)
}

/**
 * validateMeta checks a draft meta and splits findings: errors are hard
 * (required fields, invalid scope value, malformed read stats, a description
 * that merely repeats the title); warnings are discipline nudges (a long or
 * title-repeating description). memory_write refuses on errors and surfaces
 * warnings to the agent.
 */
export function validateMeta(meta: Partial<NoteMeta>): MetaValidation {
  const errors: string[] = []
  const warnings: string[] = []

  const title = normalizePhrase(meta.index_title ?? '')
  const description = normalizePhrase(meta.index_description ?? '')

  if (title === '') {
    errors.push('index_title is required; use the "Topic: Scenario" form')
  }
  if (description === '') {
    errors.push('index_description is required; give the one-line recall hook')
  } else {
    if (title !== '' && description === title) {
      errors.push('index_description must not merely repeat index_title')
    } else if (title !== '' && description.includes(title)) {
      warnings.push('index_description repeats its index_title; add the scenario the title alone misses')
    }
    const rawLength = (meta.index_description ?? '').trim().length
    if (rawLength > MAX_INDEX_DESCRIPTION_CHARS) {
      warnings.push(`index_description is ${rawLength} chars; keep the recall hook within about ${MAX_INDEX_DESCRIPTION_CHARS}`)
    }
  }

  if (meta.type === undefined || !isScopeType(meta.type)) {
    errors.push(`type must be a scope constant or kebab-case project slug, got "${meta.type ?? ''}"`)
  }
  if (meta.archive !== undefined && typeof meta.archive !== 'boolean') {
    errors.push('archive must be a boolean')
  }
  if (meta.read_count !== undefined
    && (!Number.isInteger(meta.read_count) || meta.read_count < 0)) {
    errors.push('read_count must be an integer >= 0')
  }
  for (const field of ['created', 'updated'] as const) {
    const value = meta[field]
    if (value !== undefined && value !== '' && !isIsoStamp(value)) {
      errors.push(`${field} must be a valid ISO 8601 date or timestamp, got "${value}"`)
    }
  }
  if (meta.last_read_at !== undefined && !isIsoStamp(meta.last_read_at)) {
    errors.push(`last_read_at must be a valid ISO 8601 date, got "${meta.last_read_at}"`)
  }

  return { errors, warnings }
}

/**
 * titleToFilename slugifies a note title into a kebab-case file name with
 * the .md suffix, appending -2, -3, ... to skip names already in taken
 * (collision handling for same-titled notes).
 */
export function titleToFilename(
  title: string,
  taken?: Iterable<string>,
): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'untitled'

  let candidate = `${slug}.md`
  if (taken) {
    const claimed = new Set(taken)
    let ordinal = 2
    while (claimed.has(candidate)) {
      candidate = `${slug}-${ordinal}.md`
      ordinal += 1
    }
  }
  return candidate
}

/** Tests whether the note is archived; archived notes leave search
 * defaults and reindexing, staying on disk for audit and dreams. */
export function isArchived(note: Note | NoteMeta): boolean {
  const meta = 'meta' in note ? note.meta : note
  return meta.archive === true
}

/**
 * ensureWhyAndHow returns discipline warnings when the body lacks a Why:
 * line or a How to apply: line, the two anchors that make a decision memory
 * actionable. Soft warnings for memory_write, per the turn-end policy.
 */
export function ensureWhyAndHow(body: string): string[] {
  const warnings: string[] = []
  if (!WHY_LINE.test(body)) {
    warnings.push('body lacks a "Why:" line; state why this memory exists')
  }
  if (!HOW_LINE.test(body)) {
    warnings.push('body lacks a "How to apply:" line; state how to use it')
  }
  return warnings
}

// YAML scalar coercion: strings trim, dates normalize to ISO text,
// everything else falls back to the field default at the call site.
function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  return ''
}

// A YAML date without a time arrives as a UTC-midnight Date; keeping the
// bare date form preserves the human editing of note timestamps.
function stampOf(value: unknown): string {
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  return textOf(value)
}

function boolOf(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return /^(?:true|yes|1)$/i.test(value.trim())
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  return false
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric)
    }
  }
  return 0
}

// Shape first, then calendar: Date.parse rolls impossible days like
// 2026-02-30 over to the next month, so the Y-M-D parts are round-tripped
// through Date.UTC to reject any date that normalizes away.
function isIsoStamp(value: string): boolean {
  if (!ISO_STAMP.test(value)) {
    return false
  }
  const parts = value.slice(0, 10).split('-').map(Number)
  const year = parts[0] ?? 0
  const month = parts[1] ?? 0
  const day = parts[2] ?? 0
  const utc = Date.UTC(year, month - 1, day)
  if (Number.isNaN(utc)) {
    return false
  }
  const calendar = new Date(utc)
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day
}

// Phrase identity for the repeat check: case, spacing, and trailing
// punctuation are noise a note author adds without adding meaning.
function normalizePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
}
