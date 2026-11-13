/**
 * `memory_write`: creates or updates one memory note in a shared vault's
 * indexed note tree (the vault root itself). The guard ladder is the
 * contract, in order: target inside a registered vault, reserved protocol
 * file names refuse, read-only vaults refuse explicitly, plugin-internal
 * and other non-note paths refuse, and a rewrite of an existing file
 * requires a prior memory_read whose read-registry hash still matches the
 * on-disk bytes (changed-since-read refuses with a re-read instruction; a
 * path absent from disk is the only exemption). Frontmatter goes through
 * core validateMeta (errors are values, discipline nudges come back as
 * warnings); a new file's name is slugged from index_title with collision
 * suffixes, so the response reports the FINAL absolute path. The service's
 * applyWrite does the raw-merging atomic write plus write-through reindex.
 * @module dsh-plugin-obsidian-mem/tools/write
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  classifyPath,
  contentHash,
  ensureWhyAndHow,
  formatLocalDate,
  isPluginInternalPath,
  isReservedNonIndexed,
  parseNote,
  PLUGIN_VAULT_DIR,
  titleToFilename,
  TOOL_MEMORY_WRITE,
  validateMeta,
} from '../../core/lib/index.js'
import type { NoteMeta } from '../../core/lib/index.js'
import { expandHomePath } from '../../service/lib/config.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js'
import { asRecord, optionalBoolean, requiredString } from './host.js'
import { defineMemoryTool, makePresentCall, noticeHeader, withNotice } from './toolkit.js'

/** Fast file write plus one single-file reindex. */
export const WRITE_TIMEOUT_MS = 10_000

/** The description the model sees for `memory_write`. */
export const WRITE_DESCRIPTION
  = 'Create or update one memory note in a shared vault (the vault root is the note root). Updating an existing file requires a prior memory_read of that exact path in this session; a path not on disk yet is written without one, and its filename is derived from index_title (the path you pass supplies the directory). Notes in read-only vaults are refused. The note is written atomically and queued for immediate indexing; the result reports the final absolute path and any discipline warnings.'

/** Parameter schema; every pairing and naming rule lives on its parameter. */
export const WRITE_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'index_title', 'index_description', 'type', 'contents'],
  properties: {
    path: {
      type: 'string',
      description: 'Absolute .md path inside a shared vault (the vault root is the note root). An existing file is updated at this exact path; for a new note only the directory is used and the filename is slugged from index_title.',
    },
    index_title: {
      type: 'string',
      description: 'Note title in the \'Topic: Scenario\' form, e.g. \'Typescript: Writing style\'. A new note takes its filename from this title.',
    },
    index_description: {
      type: 'string',
      description: 'One-line recall hook deciding whether to open the note: the situation it applies to and what following it changes. Do not restate index_title; stay near 120 characters.',
    },
    type: {
      type: 'string',
      description: 'Scope the memory holds true in: \'global\', \'domain\', \'reference\', or a kebab-case project slug.',
    },
    contents: {
      type: 'string',
      description: 'Complete Markdown body; the note is replaced with this text, not appended to. Keep settled facts and include a \'Why:\' line and a \'How to apply:\' line so a future reader can act on the note.',
    },
    archive: {
      type: 'boolean',
      description: 'Set true to retire the note from search defaults. Omitted: an existing note keeps its current archive state, a new note starts unarchived.',
    },
  },
}

/** Closed output union keyed on kind. */
export const WRITE_OUTPUT: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'created', 'vault', 'warnings', 'write_through'],
      properties: {
        kind: { type: 'string', const: 'written' },
        path: { type: 'string' },
        created: { type: 'boolean' },
        vault: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        write_through: { type: 'string', const: 'attempted' },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'message'],
      properties: {
        kind: { type: 'string', const: 'read_required' },
        path: { type: 'string' },
        message: { type: 'string' },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'message'],
      properties: {
        kind: { type: 'string', const: 'stale' },
        path: { type: 'string' },
        message: { type: 'string' },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'vault', 'message'],
      properties: {
        kind: { type: 'string', const: 'read_only_vault' },
        path: { type: 'string' },
        vault: { type: 'string' },
        message: { type: 'string' },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'message', 'shared_vault_roots'],
      properties: {
        kind: { type: 'string', const: 'outside_notes' },
        path: { type: 'string' },
        message: { type: 'string' },
        shared_vault_roots: { type: 'array', items: { type: 'string' } },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'message'],
      properties: {
        kind: { type: 'string', const: 'reserved_file' },
        path: { type: 'string' },
        message: { type: 'string' },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'errors'],
      properties: {
        kind: { type: 'string', const: 'invalid_meta' },
        path: { type: 'string' },
        errors: { type: 'array', items: { type: 'string' } },
        notice: { type: 'string' },
      },
    },
  ],
}

/** The value one memory_write call returns. */
export type WriteValue
  = {
    kind: 'written'
    path: string
    created: boolean
    vault: string
    warnings: string[]
    write_through: 'attempted'
    notice?: string
  }
  | { kind: 'read_required', path: string, message: string, notice?: string }
  | { kind: 'stale', path: string, message: string, notice?: string }
  | { kind: 'read_only_vault', path: string, vault: string, message: string, notice?: string }
  | { kind: 'outside_notes', path: string, message: string, shared_vault_roots: string[], notice?: string }
  | { kind: 'reserved_file', path: string, message: string, notice?: string }
  | { kind: 'invalid_meta', path: string, errors: string[], notice?: string }

/** Execute one memory_write call; every expected refusal is a value. */
export async function executeWrite(service: MemoryService, args: unknown): Promise<WriteValue> {
  const raw = asRecord(args)
  const path = requiredString(raw, 'path')
  const indexTitle = requiredString(raw, 'index_title')
  const indexDescription = requiredString(raw, 'index_description')
  const type = requiredString(raw, 'type')
  const contents = requiredString(raw, 'contents')
  const archive = optionalBoolean(raw, 'archive')

  const notice = await service.ensureMemoryAccess()

  const target = expandHomePath(path, homedir())

  const vaults = service.listVaults()
  const sharedRoots = vaults
    .filter((vault) => vault.mode === 'shared')
    .map((vault) => vault.path)
  // The shared outside_notes refusal: one construction point so every
  // non-note answer carries the same shared-vault-root echo.
  const outsideNotes = (message: string): WriteValue => withNotice({
    kind: 'outside_notes' as const,
    path: target,
    message,
    shared_vault_roots: sharedRoots,
  }, notice)

  // Guard 1: containment. Everything after this line knows its vault.
  const classified = classifyPath(vaults, target)
  if (classified === null) {
    return outsideNotes(`${target} is not inside any registered vault. memory_write targets the note tree of a shared vault.`)
  }

  // Guard 2: reserved protocol files are never authored notes. The note
  // tree excludes them from indexing, so this guard is what names them.
  if (isReservedNonIndexed(basename(target))) {
    return withNotice({
      kind: 'reserved_file' as const,
      path: target,
      message: `${basename(target)} is a reserved vault file (.INTENTS.md, DREAMS.md, *_history.md); those are owned by the plugin. Write memory as a regular .md note.`,
    }, notice)
  }

  // Guard 3: writes only go to shared vaults.
  if (classified.mode !== 'shared') {
    return withNotice({
      kind: 'read_only_vault' as const,
      path: target,
      vault: classified.vault.path,
      message: `${target} lies in read-only vault ${classified.vault.path}. Register a shared vault (settings card or config.vaults) to write memory.`,
    }, notice)
  }

  // Guard 4: in-vault paths the note tree excludes. The plugin-internal
  // dir names itself (the plugin's own sidecars); dot paths and the bare
  // vault root take the generic never-indexed answer.
  if (!classified.insideNotes) {
    return isPluginInternalPath(classified.vault.path, target)
      ? outsideNotes(`${target} lies in vault ${classified.vault.path}'s plugin-internal ${PLUGIN_VAULT_DIR}/ directory: the plugin's own sidecar files live there and are never indexed notes. Write inside the vault's note tree instead.`)
      : outsideNotes(`${target} is inside vault ${classified.vault.path} but outside its indexed note tree, so it would never be indexed.`)
  }

  // Guard 5: read-before-write staleness. The on-disk re-hash is the whole
  // point: the registry proves a read happened, the hash proves the bytes
  // under this edit are the bytes that read saw. A directory target is a
  // NEW note (the documented contract: pass the directory itself); only an
  // existing FILE triggers the read-before-write ladder.
  const targetStat = statSync(target, { throwIfNoEntry: false })
  const exists = targetStat?.isFile() ?? false
  const record = service.readRecord(target)
  let existingMeta: NoteMeta | undefined
  if (exists && record === undefined) {
    return withNotice({
      kind: 'read_required' as const,
      path: target,
      message: `${target} exists but this session has not read it. Call memory_read on it first, then repeat this write with your edits merged into what you read.`,
    }, notice)
  }
  if (exists && record !== undefined) {
    const current = readFileSync(target, 'utf8')
    if (contentHash(current) !== record.contentHash) {
      return withNotice({
        kind: 'stale' as const,
        path: target,
        message: `${target} changed on disk after your last memory_read. Call memory_read on it again and merge your edit into the fresh text before writing.`,
      }, notice)
    }
    existingMeta = parseNote(current).meta
  }

  // Guard 6: frontmatter contract. Errors refuse; discipline nudges ride
  // along on the success value.
  const today = formatLocalDate(new Date())
  const meta: NoteMeta = {
    index_title: indexTitle,
    index_description: indexDescription,
    type,
    archive: archive ?? existingMeta?.archive ?? false,
    created: existingMeta?.created ?? today,
    updated: today,
    ...(existingMeta?.last_read_at === undefined ? {} : { last_read_at: existingMeta.last_read_at }),
    read_count: existingMeta?.read_count ?? 0,
  }
  const validation = validateMeta(meta)
  if (validation.errors.length > 0) {
    return withNotice({
      kind: 'invalid_meta' as const,
      path: target,
      errors: validation.errors,
    }, notice)
  }
  const warnings = [...validation.warnings, ...ensureWhyAndHow(contents)]

  // New notes take their filename from the title (slug plus collision
  // ordinal); updates keep the exact read path so links into it hold.
  // A directory target slugs INTO that directory, not its parent.
  const newNoteDir = targetStat?.isDirectory() ? target : dirname(target)
  const finalPath = exists ? target : join(newNoteDir, titleToFilename(indexTitle, takenMarkdownNames(newNoteDir)))

  const result = await service.applyWrite(finalPath, meta, contents)
  return withNotice({
    kind: 'written' as const,
    path: result.path,
    created: result.created,
    vault: result.vaultPath,
    warnings,
    write_through: 'attempted' as const,
  }, notice)
}

// Existing .md names beside the target, for titleToFilename's collision
// suffix. A missing dir is the empty answer (applyWrite creates it).
function takenMarkdownNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir).filter((name) => name.endsWith('.md'))
}

/** Model-facing rendering of one memory_write value. */
export function renderWrite(value: WriteValue): string {
  const notice = noticeHeader(value.notice)
  if (value.kind === 'written') {
    const lines = [
      `${value.created ? 'Created' : 'Updated'} memory note: ${value.path} (vault ${value.vault}; write-through indexing ran for the note).`,
    ]
    if (value.warnings.length > 0) {
      lines.push('Warnings:', ...value.warnings.map((warning) => `- ${warning}`))
    }
    return `${notice}${lines.join('\n')}`
  }
  if (value.kind === 'invalid_meta') {
    return `${notice}memory_write refused: the frontmatter needs fixing.\n${value.errors.map((error) => `- ${error}`).join('\n')}`
  }
  // The five remaining refusals all carry their full instruction.
  return `${notice}${value.message}`
}

/** Build the memory_write definition for one service seam. */
export function createWriteTool(service: MemoryService): ToolDefinition {
  return defineMemoryTool({
    name: TOOL_MEMORY_WRITE,
    description: WRITE_DESCRIPTION,
    parameters: WRITE_PARAMETERS,
    output: WRITE_OUTPUT,
    timeoutMs: WRITE_TIMEOUT_MS,
    execute: async (args) => await executeWrite(service, args),
    render: renderWrite,
    presentCall: makePresentCall({ tool: TOOL_MEMORY_WRITE, kind: 'edit', field: 'path', fallback: '' }),
  })
}
