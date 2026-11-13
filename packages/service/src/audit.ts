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
  AUDIT_NOTE_READ_CAP_BYTES,
  defaultVaultPath,
  INTENT_HINTS,
  INTENT_MARKERS,
  INTENTS_FILE,
  isIntentMarker,
  isReservedNonIndexed,
  markdownDir,
  metadataDir,
  modelCacheDir,
  NOTE_TIMELINE_BYTES,
  parseNote,
  SCOPE_GLOBAL,
} from '../../core/lib/index.js'
import type { NoteMeta } from '../../core/lib/index.js'
import type { ResolvedObsidianMemConfig } from './config.js'
import { describeError } from './errors.js'
import { MAX_FILES_PER_VAULT, STATE_FILE_NAME } from './indexer.js'
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
export type AuditView = 'full' | 'topStale' | 'oldestUnread'

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
  markdownPresent: boolean
  metadataPresent: boolean
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
  /** Reserved protocol names found inside markdown/ (they belong at the root). */
  reservedMisplaced: string[]
  /** True when the stat walk hit its entry cap. */
  walkTruncated: boolean
  /** Bytes under the vault root (excluding dot dirs, metadata/, and the model cache). */
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
  globalNoteCount: number
  /** Absolute paths of live global notes, sorted least-read first. */
  globalNotePaths: string[]
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

/**
 * InventoryVault walks one vault read-only: the markdown/ note tree
 * (size-before-read, read cap, reserved placement, dot-dir skips), the
 * whole-tree disk usage minus the model cache, and the indexer state file.
 * Shared by the audit report and the dream plan (single source of truth).
 */
export function inventoryVault(vault: VaultEntry, fs: AuditFs): VaultInventory {
  const markdownStat = fs.stat(markdownDir(vault.path))
  const metadataStat = fs.stat(metadataDir(vault.path))
  const state = readVaultState(vault, fs)

  const notes: AuditedNote[] = []
  const reservedMisplaced: string[] = []
  let walkTruncated = false
  if (markdownStat?.directory === true) {
    let budget = MAX_FILES_PER_VAULT
    const stack: string[] = [markdownDir(vault.path)]
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
          reservedMisplaced.push(abs)
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
  }

  const usage = measureUsage(vault, fs)
  return {
    vault,
    facts: {
      exists: fs.exists(vault.path),
      markdownPresent: markdownStat?.directory === true,
      metadataPresent: metadataStat?.directory === true,
      writable: fs.stat(vault.path)?.writable ?? false,
    },
    notes,
    reservedMisplaced,
    walkTruncated: walkTruncated || usage.truncated,
    usageBytes: usage.bytes,
    state,
  }
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
  const path = join(metadataDir(vault.path), STATE_FILE_NAME)
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

// Whole-tree disk usage: stat-only, dot dirs and the (huge, not memory
// data) model cache dir and metadata/ sidecars excluded.
function measureUsage(vault: VaultEntry, fs: AuditFs): { bytes: number; truncated: boolean } {
  let bytes = 0
  let entries = 0
  let truncated = false
  const stack: string[] = [vault.path]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of fs.listDirectory(dir) ?? []) {
      if (entry.name.startsWith('.') || (dir === vault.path && (entry.name === 'models' || entry.name === 'metadata'))) {
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
function quoted(value: string, cap = 90): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > cap ? `${oneLine.slice(0, cap - 3)}...` : oneLine
  return JSON.stringify(clipped)
}

function pathList(paths: readonly string[], cap = DETAIL_LIST_CAP): string {
  const shown = paths.slice(0, cap).map((path) => quoted(path, 120))
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

/** ReadLastDreamAt answers the dream stamp from the plugin state dir. */
export function readLastDreamAt(readSource: { readFile(path: string): string | null }, dbPath: string): number | null {
  const raw = readSource.readFile(join(dbPath, 'state', 'state.json'))
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
 * GlobalBudgetReport folds the tracker echo and the note inventory into the
 * shared budget section. Audit and the dream plan read the same numbers
 * from here (single source of truth for the compaction instruction).
 */
export function globalBudgetReport(
  notes: readonly AuditedNote[],
  globalIndex: GlobalMemoryIndex & { overBudget?: boolean },
): GlobalBudgetReport {
  const globalPaths = globalNotePaths(notes)
  const usedTokens = globalIndex.usedTokens
  const budgetTokens = globalIndex.budgetTokens
  return {
    budgetTokens,
    usedTokens,
    measured: usedTokens > 0 || globalIndex.overBudget === true,
    overBudget: globalIndex.overBudget ?? usedTokens > budgetTokens,
    globalNoteCount: globalPaths.length,
    globalNotePaths: globalPaths,
  }
}

// The staleness key for topStale ranking: never-read first (epoch 0), then
// least-recently-read, then least-read, then path.
function stalenessKey(note: AuditedNote): { since: number; readCount: number; path: string } {
  const last = note.meta?.last_read_at ?? ''
  const since = last === '' ? 0 : Date.parse(last.endsWith('T') || last.length === 10 ? `${last}T23:59:59.999Z` : last)
  return { since: Number.isFinite(since) ? since : 0, readCount: note.meta?.read_count ?? 0, path: note.path }
}

/**
 * RunStoreAudit runs the full doctor pass and assembles the structured
 * report. It never provisions and never writes; the collection probe (when
 * given) is one describe plus one statistics read.
 */
export async function runStoreAudit(deps: AuditDeps, request: AuditRequest = {}): Promise<AuditReport> {
  const view: AuditView = request.view === 'topStale' || request.view === 'oldestUnread' ? request.view : 'full'
  const limit = Math.min(500, Math.max(1, Math.trunc(request.limit ?? AUDIT_DEFAULT_LIMIT)))
  const issues: AuditIssue[] = []
  const issue = (id: string, severity: AuditSeverity, detail: string, remediation: string): void => {
    issues.push({ id, severity, detail, remediation })
  }

  const inventories = deps.vaults.map((vault) => inventoryVault(vault, deps.fs))
  const allNotes = inventories.flatMap((inventory) => inventory.notes)
  const shared = inventories.filter((inventory) => inventory.vault.mode === 'shared')

  // 1. Vault existence, layout, writability, per-vault reserved placement.
  for (const inventory of inventories) {
    const { vault, facts } = inventory
    if (!facts.exists) {
      issue('vault.missing', 'ISSUE', `registered ${vault.mode} vault ${quoted(vault.path, 120)} does not exist`,
        'restore the directory or remove the entry (settings card for card vaults, the row config.vaults for settings vaults); the registry drops it on restart')
      continue
    }
    if (!facts.markdownPresent) {
      issue('vault.markdown', 'ISSUE', `vault ${quoted(vault.path, 120)} has no markdown/ directory; nothing in it is indexed`,
        `create ${quoted(markdownDir(vault.path), 120)} or re-register the vault at its real path`)
    }
    if (!facts.metadataPresent) {
      issue('vault.metadata', 'INFO', `vault ${quoted(vault.path, 120)} has no metadata/ directory yet`,
        'nothing to do: the plugin creates it when it first writes index state for this vault')
    }
    if (vault.mode === 'shared' && !facts.writable) {
      issue('vault.writable', 'ISSUE', `shared vault ${quoted(vault.path, 120)} is not writable by this process`,
        'make the directory writable, or switch the vault to read-only in the Obsidian Mem settings card')
    }
    if (vault.mode === 'read-only' && facts.writable) {
      issue('vault.readonly-writable', 'INFO', `read-only vault ${quoted(vault.path, 120)} is writable on disk`,
        'the plugin still never writes it; tighten permissions if the read-only intent is enforcement')
    }
    if (inventory.reservedMisplaced.length > 0) {
      issue('reserved.placement', 'ISSUE', `reserved protocol files sit inside ${quoted(markdownDir(vault.path), 120)}: ${pathList(inventory.reservedMisplaced)}`,
        `move them to the vault root; reserved files (.INTENTS.md, DREAMS.md, *_history.md) live outside markdown/ and are never indexed`)
    }
    if (inventory.walkTruncated) {
      issue('vault.walk-truncated', 'INFO', `the stat walk of ${quoted(vault.path, 120)} hit its entry cap`,
        'the rollups under-count this vault; split the vault or prune its note tree')
    }
  }

  // 2. Shared-vault presence and the default-vault restatement (Decision
  // log notice); audit never creates the default, it only reports it.
  if (shared.length === 0) {
    const pending = defaultVaultPath(deps.homedir)
    const exists = deps.fs.exists(pending)
    issue('vaults.default-pending', 'INFO',
      `no shared vault is registered; the default vault ${quoted(pending, 120)} ${exists ? 'already exists and' : 'will be created'} will be adopted on the first memory access (audit does not provision it)`,
      'add your own vaults in the Obsidian Mem settings card to override the default, or ignore this if the default is intended')
  }
  if (deps.status.notice !== null) {
    issue('vaults.default-in-use', 'INFO', `the default memory vault is in use: ${quoted(deps.status.notice, 200)}`,
      'register a shared vault (settings card or config.vaults) to move memory off the default')
  }

  // 3. .INTENTS.md in the first shared vault.
  const firstShared = shared[0]
  if (firstShared !== undefined && firstShared.facts.exists) {
    const intents = analyzeIntents(deps.fs, firstShared.vault.path)
    if (!intents.present) {
      issue('intents.missing', 'ISSUE', `${quoted(intents.path, 120)} is missing from the first shared vault`,
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
    issue('index.degraded', 'ISSUE', `memory index is degraded: ${quoted(status.milvus.error ?? 'milvus start failed', 200)}`,
      'restart the host to retry the Milvus start; searches answer IndexOfflineError until then')
  } else if (status.state !== 'ready') {
    issue('index.cold', 'INFO', `memory access has not run in this process; the index under ${quoted(status.milvus.dbPath, 120)} starts on the first memory tool call`,
      'nothing to do unless searches are already failing elsewhere')
  } else {
    issue('index.live', 'INFO', `milvus ${quoted(status.milvus.version ?? 'unknown version', 60)} at ${quoted(status.milvus.address ?? '?', 60)}, dbDir ${quoted(status.milvus.dbPath, 120)}`,
      'none')
  }

  let collectionCount: number | null = null
  if (status.state === 'ready' && deps.collection !== null) {
    const probe = await deps.collection()
    if (!probe.reachable) {
      issue('index.probe', 'ISSUE', `the collection probe failed: ${quoted(probe.error ?? 'unreachable', 200)}`,
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
      issue('state.missing', 'INFO', `${quoted(state.path, 120)} is absent: vault ${quoted(inventory.vault.path, 120)} was never indexed`,
        'none; the first index pass writes it')
      continue
    }
    if (state.parseError !== null) {
      issue('state.unreadable', 'ISSUE', `indexer state ${quoted(state.path, 120)} is unreadable (${state.parseError})`,
        'delete the file to force a full reindex of this vault')
      continue
    }
    if (state.modelId !== null && state.modelId !== deps.config.model.id) {
      issue('state.stale-model', 'ISSUE', `${quoted(state.path, 120)} was built with model ${quoted(state.modelId, 60)}, config names ${quoted(deps.config.model.id, 60)}`,
        'delete the state file (or restart after a dim change) to force a full reindex against the current model')
    }
    if (state.vectorDim !== null && state.vectorDim !== deps.config.vectorDim) {
      issue('state.stale-dim', 'ISSUE', `${quoted(state.path, 120)} was built at dim ${String(state.vectorDim)}, config wants ${String(deps.config.vectorDim)}`,
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
      'fix the frontmatter (an unclosed quote or fence poisons every key after it); parse errors: ' + malformed.slice(0, 3).map((note) => note.malformed).join(', '))
  }

  // 6. Model cache.
  const cache = modelCacheDir(deps.homedir)
  const cacheEntries = deps.fs.listDirectory(cache)
  if (cacheEntries === null || cacheEntries.length === 0) {
    issue('model.uncached', 'INFO', `the embedding model is not cached at ${quoted(cache, 120)} yet`,
      'the first embedding run downloads it (~135 MB); run scripts/prefetch-model.mjs to pre-seed it offline')
  }

  // 7. Dreaming: last stamp + schedules summary (Q4 audit<->dream link).
  const lastDreamAt = readLastDreamAt(deps.fs, deps.config.milvus.dbPath)
  issue('dream.last', 'INFO', lastDreamAt === null
    ? `no dream has run yet (state file ${quoted(join(deps.config.milvus.dbPath, 'state', 'state.json'), 120)})`
    : `last dream ran at ${iso(lastDreamAt)}`,
  'run memory_dream periodically; see its description for the plan/run flow')
  const schedules = status.dreaming.schedules
  issue('dreaming.schedules', 'INFO', schedules.length === 0
    ? 'no dreaming schedules are configured (memory_dream runs manually or on an agent-led request)'
    : `dreaming schedules: ${schedules.map((schedule) => quoted(schedule.label === '' ? schedule.id : schedule.label, 60)).join(', ')}`,
  'manage schedules in the Obsidian Mem settings card Dreaming section')

  // 8. Global memory budget (TASK-045 tracker echo; instruction on over).
  const budget = globalBudgetReport(allNotes, deps.globalIndex)
  if (!budget.measured) {
    issue('budget.tracker', 'INFO', `global memory injection budget tracker not yet active this process; configured budget is ${String(budget.budgetTokens)} tokens`,
      'none yet: the tracker lands with the per-session recall budget work')
  }
  if (budget.overBudget) {
    issue('budget.over', 'ISSUE',
      `global memory injection is over budget: ${String(budget.usedTokens)} of ${String(budget.budgetTokens)} tokens used`,
      `run memory_dream to process and compact all global memory markdown files, least-read first: ${pathList(budget.globalNotePaths, limit)}`)
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
