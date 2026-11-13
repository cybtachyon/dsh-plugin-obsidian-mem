/**
 * The read-only store audit engine (TASK-034, the service side of
 * `memory_audit`). It merges four sources the way the engramory doctor and
 * the engramory-ext audit canon do: the vault filesystem (stat-only walk),
 * the per-vault indexer state files, the live Milvus collection (one
 * describe + one statistics call through an injected probe), and the
 * service status/global-budget echo.
 *
 * Nothing here writes: the seam it reads through ({@link AuditFs}) has no
 * mutating method to call, no read stat is bumped, and no provisioning is
 * triggered (audit is a doctor, not an accessor). Reads are bounded because
 * the store is attacker-influenceable: note sizes are stat'd before any
 * parse, notes past AUDIT_NOTE_READ_CAP_BYTES are flagged and never opened,
 * and store text echoed into the report is quoted and truncated so a
 * hostile note cannot flood or instruct the reader. Severity splits ISSUE
 * (fix this) from INFO (context); rollups always cover the whole store
 * while the row list is bounded by `limit`.
 * @module dsh-plugin-obsidian-mem/service/audit
 */

import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_NOTE_READ_CAP_BYTES,
  clampInt,
  dbStateDir,
  DREAM_STATE_FILE,
  DREAMS_FILE,
  defaultVaultPath,
  globalFilePath,
  INTENT_HINTS,
  INTENT_MARKERS,
  INTENTS_FILE,
  isIntentMarker,
  isReservedNonIndexed,
  metadataDir,
  modelCacheDir,
  NOTE_TIMELINE_BYTES,
  parseNote,
  PLUGIN_METADATA_REL,
  SCOPE_GLOBAL,
  VAULT_MODE_READ_ONLY,
  VAULT_MODE_SHARED,
} from '../../core/lib/index.js'
import type { NoteMeta, VaultConfig } from '../../core/lib/index.js'
import type { ResolvedObsidianMemConfig } from './config.js'
import { describeError } from './errors.js'
import { indexStatePath, MAX_FILES_PER_VAULT } from './indexer.js'
import type { IndexProgress, IndexState } from './indexer.js'
import type { GlobalMemoryIndex, ObsidianMemStatus, VaultEntry } from './service.js'

/** ISSUE means fix something; INFO is report context. */
export type AuditSeverity = 'ISSUE' | 'INFO'

/** One audit finding. `remediation` is the fix instruction, never advice. */
export interface AuditIssue {
  id: string
  severity: AuditSeverity
  detail: string
  remediation: string
}

/** The bounded row list a `memory_audit` call shows. */
export const AUDIT_VIEWS = ['full', 'topStale', 'oldestUnread'] as const

/** One of the {@link AUDIT_VIEWS} note-row orders. */
export type AuditView = typeof AUDIT_VIEWS[number]

/** Request knobs of one audit pass; rollups are unbounded, rows are not. */
export interface AuditRequest {
  view?: AuditView
  limit?: number
}

/** One note as the audit saw it (size-first; big notes stay unread). */
export interface AuditedNote {
  path: string
  vaultPath: string
  /** Vault-relative posix path, the indexer state key space. */
  rel: string
  sizeBytes: number
  mtimeMs: number
  /** True past the read cap: size is known, frontmatter is not. */
  flaggedNotRead: boolean
  /** Quoted parse error; null when the note parsed (or was not read). */
  malformed: string | null
  meta: NoteMeta | null
  /** Present in the vault indexer state file. */
  indexed: boolean
}

/** One vault's stat facts. */
export interface VaultFsFacts {
  exists: boolean
  /** The vault root exists as a directory; it IS the indexed note root. */
  rootIsDirectory: boolean
  /** The <vault>/.obsidian-mem/metadata/ sidecar directory exists. */
  sidecarPresent: boolean
  writable: boolean
}

/** What the audit could read of one vault's indexer state file. */
export interface VaultStateInfo {
  path: string
  present: boolean
  parseError: string | null
  modelId: string | null
  vectorDim: number | null
  fileCount: number
  expectedChunks: number
  /** Vault-relative state keys; the `indexed` flag's lookup set. */
  fileKeys: string[]
}

/** One vault fully inventoried by {@link inventoryVault}. */
export interface VaultInventory {
  vault: VaultEntry
  facts: VaultFsFacts
  notes: AuditedNote[]
  /**
   * Reserved protocol names at paths that are never skip-indexed: copies
   * below the vault root, plus any reachable DREAMS.md (its home is the
   * dot-hidden sidecar dir, so a visible copy is misplaced wherever it sits).
   */
  reservedMisplaced: string[]
  /** True when the stat walk hit its entry cap. */
  walkTruncated: boolean
  /** Bytes under the vault root (dot dirs excluded; the model cache lives outside vaults). */
  usageBytes: number
  state: VaultStateInfo
}

/** The live-collection answer the service's injected probe produces. */
export interface CollectionProbeResult {
  reachable: boolean
  exists: boolean
  /** Stored dense_vector width, null when unknown. */
  dim: number | null
  /** Approximate entity count from collection statistics. */
  count: number | null
  error: string | null
}

/** The global-memory budget section (TASK-045 consumes what feeds this). */
export interface GlobalBudgetReport {
  budgetTokens: number
  usedTokens: number
  /** False when the tracker reported nothing measurable this process. */
  measured: boolean
  overBudget: boolean
  /** Live global notes in FULL, protected global files counted (they inject). */
  globalNoteCount: number
  /** Absolute paths of live global notes, sorted least-read first. */
  globalNotePaths: string[]
  /**
   * The compaction-target subset: live global notes that are not some
   * vault's own globalFile (TASK-015). A protected file still counts above
   * and injects every session; it just never appears in a work list.
   */
  compactableGlobalNotePaths: string[]
}

/** A report row (a bounded, model-facing projection of an AuditedNote). */
export interface AuditNoteRow {
  path: string
  sizeBytes: number
  mtimeMs: number
  readCount: number
  lastReadAt: string
  archived: boolean
  indexed: boolean
  flaggedNotRead: boolean
  oversized: boolean
}

/** The complete structured answer of one audit pass. */
export interface AuditReport {
  ok: boolean
  generatedAt: number
  view: AuditView
  limit: number
  issues: AuditIssue[]
  stats: {
    vaultCount: number
    sharedVaultCount: number
    noteCount: number
    archivedCount: number
    totalBytes: number
    vaultUsage: Array<{ vault: string; notes: number; bytes: number }>
    oversizedNotes: string[]
    hugeNotReadNotes: string[]
    malformedNotes: string[]
    indexer: IndexProgress | null
    collectionCount: number | null
    expectedChunks: number | null
    lastDreamAt: number | null
    dreamingSchedules: number
  }
  rows: AuditNoteRow[]
  totalRows: number
  budget: GlobalBudgetReport
}

/**
 * AuditFs is the strictly read-only fs seam the engine walks. There is no
 * write method to spy on: writing from the engine is unrepresentable, and
 * service-level tests additionally assert the service's own fs recorded no
 * mutation across an audit call.
 */
export interface AuditFs {
  exists(path: string): boolean
  /** Null when the path does not exist. */
  stat(path: string): { sizeBytes: number; mtimeMs: number; directory: boolean; writable: boolean } | null
  /** UTF-8 contents, or null when missing/unreadable. */
  readFile(path: string): string | null
  /** Directory entries; null when missing or unreadable. */
  listDirectory(path: string): Array<{ name: string; directory: boolean }> | null
}

/** Node implementation of {@link AuditFs} over node:fs. */
export const nodeAuditFs: AuditFs = {
  exists: (path) => existsSync(path),
  stat(path) {
    try {
      const stats = statSync(path)
      return {
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        directory: stats.isDirectory(),
        writable: isWritable(path),
      }
    } catch {
      return null
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  listDirectory(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    } catch {
      return null
    }
  },
}

// W_OK is the writability question asked; an throw is the plain "no".
function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Everything the engine reads of the live index; injected so status stays sync. */
export interface AuditDeps {
  vaults: VaultEntry[]
  status: ObsidianMemStatus
  config: ResolvedObsidianMemConfig
  globalIndex: GlobalMemoryIndex & { overBudget?: boolean }
  /** Absolute home base (no os calls inside the engine). */
  homedir: string
  fs: AuditFs
  /** Live collection probe; null when the index is cold (never contacted). */
  collection: (() => Promise<CollectionProbeResult>) | null
}

/** Per-vault walk bound: the doctor must finish on a runaway tree. */
const MAX_WALK_ENTRIES = 10_000

/** Lists cap in issue details; the report stays bounded and readable. */
const DETAIL_LIST_CAP = 20

// Per-call character caps for store text echoed through quoted(): paths
// lead every finding, error payloads need the longest room, and labels,
// model ids, and versions stay short enough to keep one issue on one line.
const ECHO_DEFAULT_CAP = 90
const ECHO_LABEL_CAP = 60
const ECHO_PATH_CAP = 120
const ECHO_TEXT_CAP = 200

// Parse errors echoed into one malformed-notes issue detail line.
const MALFORMED_ERROR_ECHO_CAP = 3

/**
 * InventoryVault walks one vault read-only: the root note tree (the vault
 * root IS the note root; size-before-read, read cap, reserved placement,
 * dot-dir skips), the whole-tree disk usage (dot dirs excluded), and the
 * indexer state file. Shared by the audit report and the dream plan (single
 * source of truth).
 */
export function inventoryVault(vault: VaultEntry, fs: AuditFs): VaultInventory {
  const rootStat = fs.stat(vault.path)
  const state = readVaultState(vault, fs)
  const walk = rootStat?.directory === true
    ? walkNoteTree(vault, state, fs)
    : { notes: [] as AuditedNote[], reservedMisplaced: [] as string[], walkTruncated: false }

  const usage = measureUsage(vault, fs)
  return {
    vault,
    facts: {
      exists: fs.exists(vault.path),
      rootIsDirectory: rootStat?.directory === true,
      sidecarPresent: fs.stat(metadataDir(vault.path))?.directory === true,
      writable: rootStat?.writable ?? false,
    },
    notes: walk.notes,
    reservedMisplaced: walk.reservedMisplaced,
    walkTruncated: walk.walkTruncated || usage.truncated,
    usageBytes: usage.bytes,
    state,
  }
}

// Note walk: stat-only traversal of the vault root with the skip gates
// (dot dirs, which covers the plugin-internal sidecar dir, and reserved
// names). Budget is the per-vault entry cap shared with the indexer.
function walkNoteTree(
  vault: VaultEntry,
  state: VaultStateInfo,
  fs: AuditFs,
): { notes: AuditedNote[]; reservedMisplaced: string[]; walkTruncated: boolean } {
  const notes: AuditedNote[] = []
  const reservedMisplaced: string[] = []
  let walkTruncated = false
  let budget = MAX_FILES_PER_VAULT
  const stack: string[] = [vault.path]
  while (stack.length > 0 && budget > 0) {
    const dir = stack.pop() as string
    for (const entry of fs.listDirectory(dir) ?? []) {
      if (entry.name.startsWith('.')) {
        continue
      }
      const abs = join(dir, entry.name)
      if (entry.directory) {
        stack.push(abs)
        continue
      }
      budget -= 1
      if (isReservedNonIndexed(entry.name)) {
        // The vault root is the documented home of .INTENTS.md and
        // *_history.md. DREAMS.md belongs to the dot-hidden sidecar dir,
        // so any copy this walk can reach, root copy included (an unmigrated
        // vault), is misplaced.
        if (dir !== vault.path || entry.name === DREAMS_FILE) {
          reservedMisplaced.push(abs)
        }
        continue
      }
      if (!entry.name.endsWith('.md')) {
        continue
      }
      notes.push(readNote(vault, abs, state, fs))
    }
    if (budget <= 0 && stack.length > 0) {
      walkTruncated = true
    }
  }
  return { notes, reservedMisplaced, walkTruncated }
}

// One note: stat first; past the read cap the file is flagged, never read.
function readNote(vault: VaultEntry, abs: string, state: VaultStateInfo, fs: AuditFs): AuditedNote {
  const stat = fs.stat(abs)
  const rel = toRel(vault.path, abs)
  const base = {
    path: abs,
    vaultPath: vault.path,
    rel,
    sizeBytes: stat?.sizeBytes ?? 0,
    mtimeMs: stat?.mtimeMs ?? 0,
    indexed: state.fileKeys.includes(rel),
  }
  if ((stat?.sizeBytes ?? 0) > AUDIT_NOTE_READ_CAP_BYTES) {
    return { ...base, flaggedNotRead: true, malformed: null, meta: null }
  }
  const text = fs.readFile(abs)
  if (text === null) {
    return { ...base, flaggedNotRead: false, malformed: '"present but unreadable"', meta: null }
  }
  try {
    return { ...base, flaggedNotRead: false, malformed: null, meta: parseNote(text).meta }
  } catch (error: unknown) {
    return { ...base, flaggedNotRead: false, malformed: quoted(describeError(error)), meta: null }
  }
}

function toRel(vaultPath: string, abs: string): string {
  const rel = abs.startsWith(vaultPath) ? abs.slice(vaultPath.length) : abs
  return rel.replace(/^[/\\]/, '').replaceAll('\\', '/')
}

// State file facts: missing is the empty answer; corrupt is reported, never
// reinterpreted (the indexer rewrites it on the next pass).
function readVaultState(vault: VaultEntry, fs: AuditFs): VaultStateInfo {
  const path = indexStatePath(vault.path)
  const raw = fs.readFile(path)
  if (raw === null) {
    return { path, present: false, parseError: null, modelId: null, vectorDim: null, fileCount: 0, expectedChunks: 0, fileKeys: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IndexState>
    const files = typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {}
    const entries = Object.entries(files)
    let chunks = 0
    for (const [, file] of entries) {
      chunks += Array.isArray((file as { chunkIds?: unknown[] })?.chunkIds) ? (file as { chunkIds: unknown[] }).chunkIds.length : 0
    }
    return {
      path,
      present: true,
      parseError: null,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : null,
      vectorDim: typeof parsed.vectorDim === 'number' ? parsed.vectorDim : null,
      fileCount: entries.length,
      expectedChunks: chunks,
      fileKeys: entries.map(([rel]) => rel),
    }
  } catch (error: unknown) {
    return { path, present: true, parseError: quoted(describeError(error)), modelId: null, vectorDim: null, fileCount: 0, expectedChunks: 0, fileKeys: [] }
  }
}

// Whole-tree disk usage: stat-only, dot dirs excluded (covers the
// .obsidian-mem sidecar dir). The model cache needs no skip here: core's
// modelCacheDir keeps it under dbDir, outside every vault.
function measureUsage(vault: VaultEntry, fs: AuditFs): { bytes: number; truncated: boolean } {
  let bytes = 0
  let entries = 0
  let truncated = false
  const stack: string[] = [vault.path]
  // Past the entry cap the walk stops: MAX_WALK_ENTRIES is what bounds the
  // doctor on a runaway tree, so it must end the traversal, not just flag.
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop() as string
    for (const entry of fs.listDirectory(dir) ?? []) {
      if (entry.name.startsWith('.')) {
        continue
      }
      entries += 1
      if (entries > MAX_WALK_ENTRIES) {
        truncated = true
        break
      }
      const abs = join(dir, entry.name)
      if (entry.directory) {
        stack.push(abs)
        continue
      }
      bytes += fs.stat(abs)?.sizeBytes ?? 0
    }
  }
  return { bytes, truncated }
}

// Echoed store text is quoted and truncated: an agent reads this report, so
// a hostile note must not flood it or pose as instructions.
function quoted(value: string, cap = ECHO_DEFAULT_CAP): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > cap ? `${oneLine.slice(0, cap - 3)}...` : oneLine
  return JSON.stringify(clipped)
}

function pathList(paths: readonly string[], cap = DETAIL_LIST_CAP): string {
  const shown = paths.slice(0, cap).map((path) => quoted(path, ECHO_PATH_CAP))
  const rest = paths.length - shown.length
  return shown.length === 0 ? 'none' : `${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// .INTENTS.md section analysis: a marker is "recorded" when its section
// holds content beyond the seed hint line.
function analyzeIntents(fs: AuditFs, vaultPath: string): { present: boolean; path: string; emptyMarkers: string[]; missingSections: string[] } {
  const path = join(vaultPath, INTENTS_FILE)
  const text = fs.readFile(path)
  if (text === null) {
    return { present: false, path, emptyMarkers: [], missingSections: [] }
  }
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const line of text.split('\n')) {
    const header = /^##\s+(\S.*?)\s*$/.exec(line)
    if (header !== null) {
      const marker = header[1] ?? ''
      current = isIntentMarker(marker) ? marker : null
      if (current !== null && !sections.has(current)) {
        sections.set(current, [])
      }
      continue
    }
    if (current !== null && line.trim() !== '') {
      sections.get(current)?.push(line.trim())
    }
  }
  const emptyMarkers: string[] = []
  const missingSections: string[] = []
  for (const marker of INTENT_MARKERS) {
    const lines = sections.get(marker)
    if (lines === undefined) {
      missingSections.push(marker)
      emptyMarkers.push(marker)
      continue
    }
    const recorded = lines.filter((line) => line !== INTENT_HINTS[marker].trim())
    if (recorded.length === 0) {
      emptyMarkers.push(marker)
    }
  }
  return { present: true, path, emptyMarkers, missingSections }
}

/** ReadDreamStateShape is the <dbPath>/state/state.json the dream writes. */
interface DreamStateFile {
  lastDreamAt?: number
}

/** DreamStatePath is the ONE location of the dream stamp file (`<dbPath>/state/state.json`). */
export function dreamStatePath(dbPath: string): string {
  return join(dbStateDir(dbPath), DREAM_STATE_FILE)
}

/** ReadLastDreamAt answers the dream stamp from the plugin state dir. */
export function readLastDreamAt(readSource: { readFile(path: string): string | null }, dbPath: string): number | null {
  const raw = readSource.readFile(dreamStatePath(dbPath))
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as DreamStateFile
    return typeof parsed.lastDreamAt === 'number' && Number.isFinite(parsed.lastDreamAt) ? parsed.lastDreamAt : null
  } catch {
    return null
  }
}

/**
 * GlobalNotePaths lists live global-scope notes sorted least-read first:
 * the order the over-budget compaction instruction names, and the dream
 * plan's budget input (shared with memory_dream, single source of truth).
 */
export function globalNotePaths(notes: readonly AuditedNote[]): string[] {
  return notes
    .filter((note) => note.meta !== null && note.meta.type === SCOPE_GLOBAL && note.meta.archive !== true)
    .sort((a, b) => {
      const byRead = (a.meta?.read_count ?? 0) - (b.meta?.read_count ?? 0)
      if (byRead !== 0) {
        return byRead
      }
      const aLast = a.meta?.last_read_at ?? ''
      const bLast = b.meta?.last_read_at ?? ''
      if (aLast !== bLast) {
        return aLast < bLast ? -1 : 1
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
    .map((note) => note.path)
}

/**
 * GlobalFileTargets answers the absolute note paths the dreaming pass must
 * never pick as compaction or merge targets: each vault's own
 * `<vault path>/<globalFile>` through the ONE joined-path definition (core
 * globalFilePath). Vaults are independent: vault A's globalFile protects
 * only the copy inside vault A. A globalFile that escapes its vault root
 * (hand-edited registry) protects nothing, mirroring the injection skip.
 */
export function globalFileTargets(vaults: readonly Pick<VaultConfig, 'path' | 'globalFile'>[]): Set<string> {
  const targets = new Set<string>()
  for (const vault of vaults) {
    const path = globalFilePath(vault)
    if (path !== null) {
      targets.add(path)
    }
  }
  return targets
}

/**
 * GlobalBudgetReport folds the tracker echo and the note inventory into the
 * shared budget section. Audit and the dream plan read the same numbers
 * from here (single source of truth for the compaction instruction).
 * Protected global files stay in `globalNoteCount` and the token math (they
 * inject into every session) but drop out of `compactableGlobalNotePaths`.
 */
export function globalBudgetReport(
  notes: readonly AuditedNote[],
  vaults: readonly Pick<VaultConfig, 'path' | 'globalFile'>[],
  globalIndex: GlobalMemoryIndex & { overBudget?: boolean },
): GlobalBudgetReport {
  const globalPaths = globalNotePaths(notes)
  const targets = globalFileTargets(vaults)
  const usedTokens = globalIndex.usedTokens
  const budgetTokens = globalIndex.budgetTokens
  return {
    budgetTokens,
    usedTokens,
    measured: usedTokens > 0 || globalIndex.overBudget === true,
    overBudget: globalIndex.overBudget ?? usedTokens > budgetTokens,
    globalNoteCount: globalPaths.length,
    globalNotePaths: globalPaths,
    compactableGlobalNotePaths: globalPaths.filter((path) => !targets.has(path)),
  }
}

/**
 * BudgetProtectedOnly reports the over-budget shape where EVERY live global
 * note is some vault's protected globalFile: neither memory_dream nor any
 * work list can reclaim budget there, only hand-tightening the file can
 * (TASK-015). Audit's instruction and the dream work plan branch on this
 * one predicate.
 */
export function budgetProtectedOnly(budget: GlobalBudgetReport): boolean {
  return budget.globalNoteCount > 0 && budget.compactableGlobalNotePaths.length === 0
}

// The budget.over instruction. Compactable files stay protected-dropped from
// the named list; when only protected files remain the instruction says
// compaction cannot help and names the files to tighten by hand.
function budgetOverRemediation(budget: GlobalBudgetReport, limit: number): string {
  if (budgetProtectedOnly(budget)) {
    return `compaction cannot help: every live global note is a vault global file the dreaming pass never compacts; manually tighten ${pathList(budget.globalNotePaths, limit)} to reclaim budget`
  }
  return `run memory_dream to process and compact the global memory markdown files, least-read first: ${pathList(budget.compactableGlobalNotePaths, limit)}`
}

/**
 * DayEnd answers the epoch of the end of the day (23:59:59.999Z) a
 * YYYY-MM-DD note stamp names, so a read on that day counts as access
 * through the whole day. Full ISO stamps parse as they are; an
 * unparseable stamp answers 0. Audit's staleness ranking and the dream
 * engine's unread-since-last-dream test share this rule (single source).
 */
export function dayEnd(stamp: string): number {
  const iso = stamp.length === 10 ? `${stamp}T23:59:59.999Z` : stamp
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : 0
}

// The staleness key for topStale ranking: never-read first (epoch 0), then
// least-recently-read, then least-read, then path.
function stalenessKey(note: AuditedNote): { since: number; readCount: number; path: string } {
  return {
    since: dayEnd(note.meta?.last_read_at ?? ''),
    readCount: note.meta?.read_count ?? 0,
    path: note.path,
  }
}

/**
 * RunStoreAudit runs the full doctor pass and assembles the structured
 * report. It never provisions and never writes; the collection probe (when
 * given) is one describe plus one statistics read.
 */
export async function runStoreAudit(deps: AuditDeps, request: AuditRequest = {}): Promise<AuditReport> {
  const view: AuditView = request.view === 'topStale' || request.view === 'oldestUnread' ? request.view : 'full'
  const limit = clampInt(Math.trunc(request.limit ?? AUDIT_DEFAULT_LIMIT), 1, AUDIT_MAX_LIMIT)
  const issues: AuditIssue[] = []
  const issue = (id: string, severity: AuditSeverity, detail: string, remediation: string): void => {
    issues.push({ id, severity, detail, remediation })
  }

  const inventories = deps.vaults.map((vault) => inventoryVault(vault, deps.fs))
  const allNotes = inventories.flatMap((inventory) => inventory.notes)
  const shared = inventories.filter((inventory) => inventory.vault.mode === VAULT_MODE_SHARED)

  // 1. Vault existence, layout, writability, per-vault reserved placement.
  for (const inventory of inventories) {
    const { vault, facts } = inventory
    if (!facts.exists) {
      issue('vault.missing', 'ISSUE', `registered ${vault.mode} vault ${quoted(vault.path, ECHO_PATH_CAP)} does not exist`,
        'restore the directory or remove the entry (settings card for card vaults, the row config.vaults for settings vaults); the registry drops it on restart')
      continue
    }
    if (!facts.rootIsDirectory) {
      issue('vault.root-not-directory', 'ISSUE', `vault ${quoted(vault.path, ECHO_PATH_CAP)} is not a directory; nothing in it is indexed`,
        're-register the vault at its real path (the vault root is the indexed note root)')
    }
    if (!facts.sidecarPresent) {
      issue('vault.sidecar-missing', 'INFO', `vault ${quoted(vault.path, ECHO_PATH_CAP)} has no ${PLUGIN_METADATA_REL}/ directory yet`,
        'nothing to do: the plugin creates it when it first writes index state for this vault')
    }
    if (vault.mode === VAULT_MODE_SHARED && !facts.writable) {
      issue('vault.writable', 'ISSUE', `shared vault ${quoted(vault.path, ECHO_PATH_CAP)} is not writable by this process`,
        'make the directory writable, or switch the vault to read-only in the Obsidian Mem settings card')
    }
    if (vault.mode === VAULT_MODE_READ_ONLY && facts.writable) {
      issue('vault.readonly-writable', 'INFO', `read-only vault ${quoted(vault.path, ECHO_PATH_CAP)} is writable on disk`,
        'the plugin still never writes it; tighten permissions if the read-only intent is enforcement')
    }
    if (inventory.reservedMisplaced.length > 0) {
      issue('reserved.placement', 'ISSUE', `reserved protocol files sit outside their skip-indexed placement in ${quoted(vault.path, ECHO_PATH_CAP)}: ${pathList(inventory.reservedMisplaced)}`,
        `move .INTENTS.md and *_history.md copies to the vault root; for DREAMS.md move it to <vault>/${PLUGIN_METADATA_REL}/. Reserved files are never indexed from any other placement`)
    }
    if (inventory.walkTruncated) {
      issue('vault.walk-truncated', 'INFO', `the stat walk of ${quoted(vault.path, ECHO_PATH_CAP)} hit its entry cap`,
        'the rollups under-count this vault; split the vault or prune its note tree')
    }
  }

  // 2. Shared-vault presence and the default-vault restatement (Decision
  // log notice); audit never creates the default, it only reports it.
  if (shared.length === 0) {
    const pending = defaultVaultPath(deps.homedir)
    const exists = deps.fs.exists(pending)
    issue('vaults.default-pending', 'INFO',
      `no shared vault is registered; the default vault ${quoted(pending, ECHO_PATH_CAP)} ${exists ? 'already exists and' : 'will be created'} will be adopted on the first memory access (audit does not provision it)`,
      'add your own vaults in the Obsidian Mem settings card to override the default, or ignore this if the default is intended')
  }
  if (deps.status.notice !== null) {
    issue('vaults.default-in-use', 'INFO', `the default memory vault is in use: ${quoted(deps.status.notice, ECHO_TEXT_CAP)}`,
      'register a shared vault (settings card or config.vaults) to move memory off the default')
  }

  // 3. .INTENTS.md in the first shared vault.
  const firstShared = shared[0]
  if (firstShared !== undefined && firstShared.facts.exists) {
    const intents = analyzeIntents(deps.fs, firstShared.vault.path)
    if (!intents.present) {
      issue('intents.missing', 'ISSUE', `${quoted(intents.path, ECHO_PATH_CAP)} is missing from the first shared vault`,
        `create it with one "## marker" section per intent (${INTENT_MARKERS.join(', ')}); provisioning also seeds this exact file on first memory access`)
    } else if (intents.emptyMarkers.length > 0) {
      const all = intents.emptyMarkers.length === INTENT_MARKERS.length
      issue('intents.empty', 'INFO',
        `${intents.missingSections.length > 0 ? `sections missing for ${pathList(intents.missingSections)}; ` : ''}intent markers with no recorded intents${all ? ' (all nine, the file is seed-only)' : ''}: ${pathList(intents.emptyMarkers)}`,
        'record at least one line under a marker when this vault should wake notes for that intent')
    }
  }

  // 4. Milvus / collection / indexer pipeline.
  const status = deps.status
  if (status.state === 'degraded') {
    issue('index.degraded', 'ISSUE', `memory index is degraded: ${quoted(status.milvus.error ?? 'milvus start failed', ECHO_TEXT_CAP)}`,
      'restart the host to retry the Milvus start; searches answer IndexOfflineError until then')
  } else if (status.state !== 'ready') {
    issue('index.cold', 'INFO', `memory access has not run in this process; the index under ${quoted(status.milvus.dbPath, ECHO_PATH_CAP)} starts on the first memory tool call`,
      'nothing to do unless searches are already failing elsewhere')
  } else {
    issue('index.live', 'INFO', `milvus ${quoted(status.milvus.version ?? 'unknown version', ECHO_LABEL_CAP)} at ${quoted(status.milvus.address ?? '?', ECHO_LABEL_CAP)}, dbDir ${quoted(status.milvus.dbPath, ECHO_PATH_CAP)}`,
      'none')
  }

  let collectionCount: number | null = null
  if (status.state === 'ready' && deps.collection !== null) {
    const probe = await deps.collection()
    if (!probe.reachable) {
      issue('index.probe', 'ISSUE', `the collection probe failed: ${quoted(probe.error ?? 'unreachable', ECHO_TEXT_CAP)}`,
        'check the milvus child and restart the host, then re-run the audit')
    } else if (!probe.exists) {
      issue('collection.missing', 'ISSUE', `collection "obsidian_mem" does not exist although the index reports ready`,
        'restart the host: provisioning recreates the collection and forces a full reindex')
    } else {
      if (probe.dim !== null && probe.dim !== deps.config.vectorDim) {
        issue('collection.dim-drift', 'ISSUE', `collection stores ${String(probe.dim)}-d vectors, config wants ${String(deps.config.vectorDim)}-d`,
          'restart the host: dim drift rebuilds the collection and forces a full reindex')
      }
      collectionCount = probe.count
    }
  }

  const expectedChunks = inventories.reduce((sum, inventory) => sum + inventory.state.expectedChunks, 0)
  if (collectionCount !== null && Math.abs(collectionCount - expectedChunks) > 0) {
    issue('index.count-drift', 'INFO', `collection holds ${String(collectionCount)} chunks, vault state files expect ${String(expectedChunks)} (drift ${String(Math.abs(collectionCount - expectedChunks))})`,
      'lite statistics are approximate; a large or growing drift re-runs after a restart, else force a full reindex from the settings card')
  }

  const progress = status.indexer
  if (progress !== null) {
    if (progress.errors > 0) {
      issue('indexer.errors', 'ISSUE', `the indexer has ${String(progress.errors)} cumulative failures this process`,
        'check that every vault path is readable; the failed files stay dirty and retry on the next sweep')
    }
    if (progress.llmErrors > 0) {
      issue('indexer.llm-errors', 'INFO', `the indexer fell back to heuristic keywords ${String(progress.llmErrors)} times (llmErrors)`,
        'llm.enabled config and the apiKeyEnv variable need checking only if the LLM pass is wanted')
    }
    if (progress.pending > 0) {
      issue('indexer.pending', 'INFO', `${String(progress.pending)} files are queued for indexing`,
      'none; the sweep picks them up within its poll interval')
    }
  }

  for (const inventory of inventories) {
    const { state } = inventory
    if (!state.present) {
      issue('state.missing', 'INFO', `${quoted(state.path, ECHO_PATH_CAP)} is absent: vault ${quoted(inventory.vault.path, ECHO_PATH_CAP)} was never indexed`,
        'none; the first index pass writes it')
      continue
    }
    if (state.parseError !== null) {
      issue('state.unreadable', 'ISSUE', `indexer state ${quoted(state.path, ECHO_PATH_CAP)} is unreadable (${state.parseError})`,
        'delete the file to force a full reindex of this vault')
      continue
    }
    if (state.modelId !== null && state.modelId !== deps.config.model.id) {
      issue('state.stale-model', 'ISSUE', `${quoted(state.path, ECHO_PATH_CAP)} was built with model ${quoted(state.modelId, ECHO_LABEL_CAP)}, config names ${quoted(deps.config.model.id, ECHO_LABEL_CAP)}`,
        'delete the state file (or restart after a dim change) to force a full reindex against the current model')
    }
    if (state.vectorDim !== null && state.vectorDim !== deps.config.vectorDim) {
      issue('state.stale-dim', 'ISSUE', `${quoted(state.path, ECHO_PATH_CAP)} was built at dim ${String(state.vectorDim)}, config wants ${String(deps.config.vectorDim)}`,
        'delete the state file (or restart) to force a full reindex at the configured width')
    }
  }

  // 5. Note bloat classes: oversized (timeline), huge-not-read, malformed.
  const oversized = allNotes
    .filter((note) => !note.flaggedNotRead && note.sizeBytes > NOTE_TIMELINE_BYTES)
    .map((note) => note.path)
    .sort()
  if (oversized.length > 0) {
    issue('notes.oversized', 'INFO', `notes past the ${String(NOTE_TIMELINE_BYTES)}-byte timeline bar: ${pathList(oversized, limit)}`,
      'run memory_dream (or split by hand): keep the conclusion, move history to a <slug>_history.md note at the vault root')
  }
  const huge = allNotes.filter((note) => note.flaggedNotRead).map((note) => note.path).sort()
  if (huge.length > 0) {
    issue('notes.huge-not-read', 'INFO', `notes past the ${String(AUDIT_NOTE_READ_CAP_BYTES)}-byte read cap were flagged, not opened: ${pathList(huge, limit)}`,
      'open them in a file manager to decide; archive or split anything that only records history')
  }
  const malformed = allNotes.filter((note) => note.malformed !== null)
  if (malformed.length > 0) {
    issue('notes.malformed', 'ISSUE', `notes that could not be read or whose frontmatter failed to parse: ${pathList(malformed.map((note) => note.path), limit)}`,
      'fix the frontmatter (an unclosed quote or fence poisons every key after it); parse errors: ' + malformed.slice(0, MALFORMED_ERROR_ECHO_CAP).map((note) => note.malformed).join(', '))
  }

  // 6. Model cache.
  const cache = modelCacheDir(deps.homedir)
  const cacheEntries = deps.fs.listDirectory(cache)
  if (cacheEntries === null || cacheEntries.length === 0) {
    issue('model.uncached', 'INFO', `the embedding model is not cached at ${quoted(cache, ECHO_PATH_CAP)} yet`,
      'the first embedding run downloads it (~135 MB); run scripts/prefetch-model.mjs to pre-seed it offline')
  }

  // 7. Dreaming: last stamp + schedules summary (Q4 audit<->dream link).
  const lastDreamAt = readLastDreamAt(deps.fs, deps.config.milvus.dbPath)
  issue('dream.last', 'INFO', lastDreamAt === null
    ? `no dream has run yet (state file ${quoted(dreamStatePath(deps.config.milvus.dbPath), ECHO_PATH_CAP)})`
    : `last dream ran at ${iso(lastDreamAt)}`,
  'run memory_dream periodically; see its description for the plan/run flow')
  const schedules = status.dreaming.schedules
  issue('dreaming.schedules', 'INFO', schedules.length === 0
    ? 'no dreaming schedules are configured (memory_dream runs manually or on an agent-led request)'
    : `dreaming schedules: ${schedules.map((schedule) => quoted(schedule.label === '' ? schedule.id : schedule.label, ECHO_LABEL_CAP)).join(', ')}`,
  'manage schedules in the Obsidian Mem settings card Dreaming section')

  // 8. Global memory budget (TASK-045 tracker echo; instruction on over).
  const budget = globalBudgetReport(allNotes, deps.vaults, deps.globalIndex)
  if (!budget.measured) {
    issue('budget.tracker', 'INFO', `no recall budget spent in this process yet; configured budget is ${String(budget.budgetTokens)} tokens`,
      'none: usage counts from the first turn-start recall injection')
  }
  if (budget.overBudget) {
    issue('budget.over', 'ISSUE',
      `global memory injection is over budget: ${String(budget.usedTokens)} of ${String(budget.budgetTokens)} tokens used, injected since the last successful dream or host restart`,
      budgetOverRemediation(budget, limit))
  }

  // 9. Rows: bounded view; rollups above covered the whole store.
  const live = allNotes.filter((note) => note.meta?.archive !== true)
  let eligible = allNotes
  if (view === 'topStale') {
    eligible = live
  } else if (view === 'oldestUnread') {
    eligible = live.filter((note) => (note.meta?.read_count ?? 0) === 0 && (note.meta?.last_read_at ?? '') === '')
  }
  const sorted = [...eligible].sort((a, b) => {
    if (view === 'oldestUnread') {
      return a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1)
    }
    if (view === 'topStale') {
      const ka = stalenessKey(a)
      const kb = stalenessKey(b)
      return ka.since - kb.since || ka.readCount - kb.readCount || (ka.path < kb.path ? -1 : 1)
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  const rows: AuditNoteRow[] = sorted.slice(0, limit).map((note) => ({
    path: note.path,
    sizeBytes: note.sizeBytes,
    mtimeMs: note.mtimeMs,
    readCount: note.meta?.read_count ?? 0,
    lastReadAt: note.meta?.last_read_at ?? '',
    archived: note.meta?.archive === true,
    indexed: note.indexed,
    flaggedNotRead: note.flaggedNotRead,
    oversized: !note.flaggedNotRead && note.sizeBytes > NOTE_TIMELINE_BYTES,
  }))

  issues.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'ISSUE' ? -1 : 1
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return {
    ok: issues.every((entry) => entry.severity !== 'ISSUE'),
    generatedAt: Date.now(),
    view,
    limit,
    issues,
    stats: {
      vaultCount: inventories.length,
      sharedVaultCount: shared.length,
      noteCount: allNotes.length,
      archivedCount: allNotes.filter((note) => note.meta?.archive === true).length,
      totalBytes: inventories.reduce((sum, inventory) => sum + inventory.usageBytes, 0),
      vaultUsage: inventories.map((inventory) => ({
        vault: inventory.vault.path,
        notes: inventory.notes.length,
        bytes: inventory.usageBytes,
      })),
      oversizedNotes: oversized,
      hugeNotReadNotes: huge,
      malformedNotes: malformed.map((note) => note.path),
      indexer: progress,
      collectionCount,
      expectedChunks,
      lastDreamAt,
      dreamingSchedules: schedules.length,
    },
    rows,
    totalRows: sorted.length,
    budget,
  }
}
