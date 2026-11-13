/**
 * Indexer keeps every registered vault's chunks in the `obsidian_mem`
 * collection (TASK-023): per-vault diff state under
 * `<vault>/metadata/obsidian-mem-state.json`, the parse → chunk →
 * trigger-extract → embed → delete-stale → insert pipeline, the
 * activation/watcher/write-through triggers, progress counters for ui and
 * audit, and the optional LLM refinement pass that merges onto the core
 * heuristics and never blocks indexing.
 *
 * Milvus invariants honored here (docs/research/milvus-transformers-findings.md):
 * all writes serialize through ONE TS queue (lite is single-writer, §3),
 * every response passes assertOk (G1/G2), chunk ids bake in modelId and
 * vectorDim so a model/dim swap changes every id and the stale-delete is
 * the migration (core/idhash), and state is written atomically
 * (tmp+rename) with a content diff that makes "Milvus offline, retry on
 * the next run" correct by construction.
 *
 * Assumes the collection exists and is loaded: ensureCollection/
 * loadCollectionSync are the caller's (service ensureMemoryAccess),
 * because getLoadState lies on lite (G5/G6).
 * @module dsh-plugin-obsidian-mem/service/indexer
 */

import { watch as fsWatch } from 'node:fs'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  chunkId,
  chunkMarkdown,
  contentHash,
  extractTriggers,
  isArchived,
  isReservedNonIndexed,
  isScopeType,
  markdownDir,
  metadataDir,
  MILVUS_COLLECTION,
  MILVUS_FIELDS,
  parseNote,
  SCOPE_GLOBAL,
  stripNoise,
} from '../../core/lib/index.js'
import type { VaultConfig } from '../../core/lib/index.js'
import type { Embedder } from './embedder.js'
import { assertOk } from './milvus/ok.js'

/** Schema version of the per-vault state file. */
export const INDEX_STATE_VERSION = 1
/** State file name inside `<vault>/metadata/`. */
export const STATE_FILE_NAME = 'obsidian-mem-state.json'
/** Watcher debounce window; memsearch watchdog value. */
export const WATCH_DEBOUNCE_MS = 1500
/** Polling fallback interval when recursive fs.watch is unavailable. */
export const POLL_INTERVAL_MS = 30_000
/** Hard cap on indexed files per vault; the walk stops past it. */
export const MAX_FILES_PER_VAULT = 2000
/** Hard cap on chunks indexed per file; later sections are dropped. */
export const MAX_CHUNKS_PER_FILE = 128

// Schema max_lengths that inserts must not exceed (milvus/schema.ts).
const SOURCE_PATH_MAX_CHARS = 1024
const SECTION_HEADER_MAX_CHARS = 512
const CHUNK_TEXT_MAX_CHARS = 65_535
const VAULT_MAX_CHARS = 256

// LLM refinement limits: 6000 chars of chunk text per prompt, and three
// consecutive failures open the per-run circuit so an offline endpoint
// cannot add a timeout to every chunk.
const LLM_INPUT_CHAR_CAP = 6000
const LLM_FAILURE_CIRCUIT = 3
const LLM_REQUEST_TIMEOUT_MS = 15_000

/** Per-file record in the vault state file. */
export interface IndexFileState {
  contentHash: string
  mtimeMs: number
  chunkIds: number[]
}

/** The `<vault>/metadata/obsidian-mem-state.json` document. */
export interface IndexState {
  version: number
  /** Embedding model id the stored chunkIds were hashed with. */
  modelId: string
  /** Vector width the stored vectors were built at. */
  vectorDim: number
  /** Vault-relative path ("markdown/note.md", posix separators) keyed. */
  files: Record<string, IndexFileState>
}

/** Live progress counters consumed by ui status and memory_audit. */
export interface IndexProgress {
  /** Files fully (re)indexed since construction; cumulative. */
  indexed: number
  /** Files queued: watcher-dirty now plus the current run's remainder. */
  pending: number
  /** Cumulative failures: Milvus writes, parses, per-file errors. */
  errors: number
  /** Cumulative LLM refinement failures (fallbacks to heuristics). */
  llmErrors: number
}

/** One inserted chunk row keyed by the MILVUS_FIELDS names. */
export type IndexChunkRow = Record<string, unknown>

/** The write slice of a Milvus client the indexer needs. */
export interface IndexWriter {
  insert(request: { collection_name: string; data: IndexChunkRow[] }): Promise<unknown>
  delete(request: { collection_name: string; ids: number[] }): Promise<unknown>
}

/** A directory entry as the vault walk needs it. */
export interface IndexDirEntry {
  name: string
  directory: boolean
}

/**
 * IndexerFs is the fs seam the indexer walks and writes through. All
 * paths reaching it are absolute; tests use an in-memory tree.
 */
export interface IndexerFs {
  /** Lists a directory; null when missing or unreadable (skip it). */
  listDirectory(path: string): IndexDirEntry[] | null
  /** Reads a UTF-8 file; null when the file is gone. */
  readFile(path: string): string | null
  /** Writes a UTF-8 file, replacing any previous content. */
  writeFile(path: string, contents: string): void
  /** Atomically replaces `to` with `from` (same filesystem). */
  rename(from: string, to: string): void
  /** File stat mtime in ms; null when the path is gone. */
  stat(path: string): { mtimeMs: number } | null
  /** Creates the directory and any missing parents. */
  mkdirp(path: string): void
}

/** Node implementation of IndexerFs over node:fs. */
export const nodeIndexerFs: IndexerFs = {
  listDirectory(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
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
  writeFile(path, contents) {
    writeFileSync(path, contents, 'utf8')
  },
  rename(from, to) {
    renameSync(from, to)
  },
  stat(path) {
    try {
      return { mtimeMs: statSync(path).mtimeMs }
    } catch {
      return null
    }
  },
  mkdirp(path) {
    mkdirSync(path, { recursive: true })
  },
}

/** Handle returned by a WatchFactory; close() releases the OS watch. */
export interface WatchHandle {
  close(): void
}

/** Watch callback: changed paths relative to the watched dir, or null. */
export type WatchListener = (fileName: string | null) => void

/**
 * WatchFactory starts a recursive watch on `path`; null means recursive
 * watching is unavailable and the indexer falls back to stat polling.
 * The listener receives changed paths relative to `path`, or null for an
 * unattributable change (rescan the vault).
 */
export type WatchFactory = (path: string, listener: WatchListener) => WatchHandle | null

/** Node recursive fs.watch implementation of WatchFactory. */
export const nodeWatchFactory: WatchFactory = (path, listener) => {
  try {
    const watcher = fsWatch(path, { recursive: true }, (_event, fileName) => {
      listener(typeof fileName === 'string' ? fileName : null)
    })
    watcher.on('error', () => {
      // A dead watcher is handled by the 30 s stat poll the indexer also
      // runs; close so the broken handle is not mistaken for a live watch.
      try {
        watcher.close()
      } catch {
        // already closed
      }
    })
    return { close: () => { watcher.close() } }
  } catch {
    return null
  }
}

/** Chat-completion config; Q3's optional LLM upgrade over the heuristics. */
export interface LlmRefineConfig {
  enabled: boolean
  /** OpenAI-compatible base URL; the pass POSTs `<baseUrl>/chat/completions`. */
  baseUrl: string
  model: string
  /** Env var NAME holding the bearer key; unset means no auth header. */
  apiKeyEnv?: string
}

/** Fetch-slice the LLM pass calls; tests inject a fake, Node 22 fetch fits. */
export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status?: number; ok?: boolean; json(): Promise<unknown> }>

/** Options for one VaultIndexer. */
export interface VaultIndexerOptions {
  vault: VaultConfig
  embedder: Embedder
  writer: IndexWriter
  /** Fs seam; default nodeIndexerFs. */
  fs?: IndexerFs
  /** Watch seam; default nodeWatchFactory. */
  watchFactory?: WatchFactory
  /** Optional LLM refinement pass; absent or disabled means heuristics only. */
  llm?: LlmRefineConfig
  /** Fetch seam for the LLM pass. */
  fetch?: LlmFetch
  /** Env for the LLM api-key lookup; default process.env. */
  env?: Record<string, string | undefined>
  /** Workspace-manifest framework labels offered to trigger extraction. */
  frameworkVocabulary?: readonly string[]
  collectionName?: string
  log?: (message: string) => void
}

/** Outcome counters of one reindex() run. */
export interface IndexRunSummary {
  /** Files re-embedded and inserted. */
  indexed: number
  /** Chunks purged: removed files plus archived notes. */
  purged: number
  /** Failures this run (also in the cumulative progress.errors). */
  errors: number
}

/** Per-file outcome of processFile/applyRemovedFile. */
type FileOutcome = 'indexed' | 'purged' | 'unchanged'

/**
 * VaultIndexer owns one vault's state file, pipeline, watcher, and write
 * queue. Constructing starts nothing: start() runs the background
 * full-scan and arms the watcher, reindex()/indexFile() are the manual
 * and write-through entries. The Milvus collection must already exist
 * and be loaded (schema.ts ensureCollection + loadCollectionSync); this
 * module never creates or loads it.
 */
export class VaultIndexer {
  readonly vault: VaultConfig
  private readonly embedder: Embedder
  private readonly writer: IndexWriter
  private readonly fsLike: IndexerFs
  private readonly watchFactory: WatchFactory
  private readonly llm: LlmRefineConfig
  private readonly fetchImpl: LlmFetch | null
  private readonly env: Record<string, string | undefined>
  private readonly frameworkVocabulary: readonly string[]
  private readonly collectionName: string
  private readonly log: (message: string) => void

  private state: IndexState
  private indexed = 0
  private errors = 0
  private llmErrors = 0
  private runRemaining = 0
  private readonly dirty = new Set<string>()
  private dirtyAll = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private watchHandle: WatchHandle | null = null
  private stopped = false
  // Every index operation runs one at a time: the state file and the
  // dirty queue are shared between reindex(), indexFile(), and the
  // watcher flush, and there is exactly one writer to lite.
  private opTail: Promise<unknown> = Promise.resolve()
  // Separate mutation queue: every delete/insert pair reaches Milvus in
  // issue order on its own, so a slow embed never idles the writer.
  private writeTail: Promise<unknown> = Promise.resolve()
  private llmConsecutiveFailures = 0
  private llmCircuitOpen = false

  constructor(options: VaultIndexerOptions) {
    this.vault = options.vault
    this.embedder = options.embedder
    this.writer = options.writer
    this.fsLike = options.fs ?? nodeIndexerFs
    this.watchFactory = options.watchFactory ?? nodeWatchFactory
    this.llm = options.llm ?? { enabled: false, baseUrl: '', model: '' }
    this.fetchImpl = options.fetch ?? null
    this.env = options.env ?? process.env
    this.frameworkVocabulary = options.frameworkVocabulary ?? []
    this.collectionName = options.collectionName ?? MILVUS_COLLECTION
    this.log = options.log ?? ((message) => console.warn(`[obsidian-mem indexer] ${message}`))
    this.state = this.readStateFromDisk()
  }

  /** Path of the vault's state file. */
  get stateFilePath(): string {
    return join(metadataDir(this.vault.path), STATE_FILE_NAME)
  }

  /** Progress snapshots the ui status card and memory_audit read. */
  get progress(): IndexProgress {
    return {
      indexed: this.indexed,
      pending: this.runRemaining + this.dirty.size,
      errors: this.errors,
      llmErrors: this.llmErrors,
    }
  }

  /**
   * Start arms activation triggers: a background full-scan (not awaited)
   * plus the debounced watcher with its 30 s stat-poll safety net. Read-
   * only vaults are indexed too: recall works, only writes are refused.
   */
  start(): void {
    this.stopped = false
    this.watchHandle = this.watchFactory(markdownDir(this.vault.path), (fileName) => {
      this.onWatchEvent(fileName)
    })
    // The poll is both the fallback when fs.watch is unavailable and the
    // safety net for dropped watcher events; it is stat-only and cheap.
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => {
        this.pollStats()
      }, POLL_INTERVAL_MS)
      this.pollTimer.unref?.()
    }
    void this.reindex().catch((error: unknown) => {
      this.errors += 1
      this.log(`background reindex failed for ${this.vault.path}: ${describeError(error)}`)
    })
  }

  /** Stop releases the watcher and timers; queued work is dropped. */
  stop(): void {
    this.stopped = true
    this.watchHandle?.close()
    this.watchHandle = null
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.dirty.clear()
    this.dirtyAll = false
  }

  /** Reindex diffs the whole vault against the state file and applies it. */
  reindex(): Promise<IndexRunSummary> {
    return this.enqueueOp(async () => {
      const started = Date.now()
      const files = this.listMarkdownFiles()
      const baseline = this.state
      const forceFull = this.stateNeedsFullRebuild(baseline)
      if (forceFull) {
        this.log(`model/dim/version drift for ${this.vault.path}: full re-embed`)
      }

      const summary: IndexRunSummary = { indexed: 0, purged: 0, errors: this.errors }
      const present = new Set(files)
      this.runRemaining = files.length
      this.llmConsecutiveFailures = 0
      this.llmCircuitOpen = false

      for (const removedRel of Object.keys(baseline.files)) {
        if (!present.has(removedRel)) {
          try {
            if (await this.applyRemovedFile(removedRel) === 'purged') {
              summary.purged += 1
            }
          } catch (error) {
            // Offline deletes keep the state entry; the next run retries.
            this.errors += 1
            this.log(`delete of ${removedRel} failed: ${describeError(error)}`)
          }
        }
      }

      for (const rel of files) {
        this.runRemaining -= 1
        try {
          const outcome = await this.processFile(rel, forceFull)
          if (outcome === 'indexed') {
            summary.indexed += 1
          } else if (outcome === 'purged') {
            summary.purged += 1
          }
        } catch (error) {
          this.errors += 1
          this.log(`file ${rel} failed: ${describeError(error)}`)
        }
      }

      summary.errors = this.errors - summary.errors
      if (summary.errors === 0) {
        // Stamp the model this state now reflects; see saveState's note
        // on why the stamp only moves after a clean full run.
        this.state.version = INDEX_STATE_VERSION
        this.state.modelId = this.embedder.modelId
        this.state.vectorDim = this.embedder.dim
        this.saveState()
      }
      this.log(`reindex ${this.vault.path}: ${summary.indexed} indexed, `
        + `${summary.purged} purged, ${summary.errors} errors in ${Date.now() - started} ms`)
      return summary
    })
  }

  /**
   * IndexFile is the write-through hook for memory_write: re-index one
   * vault-relative (or vault-absolute) path immediately. Missing files
   * are treated as removals.
   */
  indexFile(relPath: string): Promise<void> {
    const rel = this.normalizeRel(relPath)
    if (rel === null) {
      return Promise.resolve()
    }
    return this.enqueueOp(async () => {
      await this.processFile(rel, false)
    })
  }

  // The single operation lane. Watcher flushes, reindex(), and
  // indexFile() all queue here so the in-memory state stays coherent.
  private enqueueOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(op, op)
    this.opTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // The single Milvus mutation lane: lite tolerates concurrent readers
  // but not concurrent writers (findings §3 "serialize writes").
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task)
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // Diff one file against the state baseline. 'indexed' means the file
  // was re-embedded and inserted; 'purged' means its chunks were
  // deleted (removed from disk or archived); 'unchanged' touched nothing.
  private async processFile(rel: string, forceFull: boolean): Promise<FileOutcome> {
    const absolute = join(this.vault.path, rel)
    const text = this.fsLike.readFile(absolute)
    if (text === null) {
      return this.applyRemovedFile(rel)
    }

    const hash = contentHash(text)
    const stored = this.state.files[rel]
    if (!forceFull && stored !== undefined && stored.contentHash === hash) {
      return 'unchanged'
    }

    const note = parseNote(text)
    const mtimeMs = this.fsLike.stat(absolute)?.mtimeMs ?? Date.now()

    // Archived notes stay on disk for audit and dreams but leave the
    // index. The state entry is KEPT (with the hash and no chunk ids)
    // so the poll and later runs see the file as settled; un-archiving
    // edits the file, the contentHash drifts, and the note re-indexes.
    if (isArchived(note.meta)) {
      const archivedStaleIds = stored?.chunkIds ?? []
      if (archivedStaleIds.length > 0) {
        try {
          await this.enqueueWrite(async () => {
            assertOk(await this.writer.delete({
              collection_name: this.collectionName,
              ids: archivedStaleIds,
            }), 'indexer delete-archived')
          })
        } catch (error) {
          this.errors += 1
          this.log(`archived purge failed for ${rel} (state kept dirty): ${describeError(error)}`)
          return 'unchanged'
        }
      }
      this.state.files[rel] = { contentHash: hash, mtimeMs, chunkIds: [] }
      this.saveState()
      return 'purged'
    }

    const chunks = chunkMarkdown({ source_path: rel, text })
    if (chunks.length > MAX_CHUNKS_PER_FILE) {
      this.log(`${rel}: ${chunks.length} chunks truncated to ${MAX_CHUNKS_PER_FILE}`)
    }
    const kept = chunks.slice(0, MAX_CHUNKS_PER_FILE)
    const vectors = await this.embedder.embedPassages(kept.map((chunk) => stripNoise(chunk.chunk_text)))
    if (vectors.length !== kept.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${kept.length} chunks`)
    }

    const scope = isScopeType(note.meta.type) ? note.meta.type : SCOPE_GLOBAL
    const newIds = kept.map((chunk) => chunkId({
      vault: this.vault.path.slice(0, VAULT_MAX_CHARS),
      source_path: rel,
      header_hash: chunk.header_hash,
      part: chunk.part,
      modelId: this.embedder.modelId,
      vectorDim: this.embedder.dim,
    }))
    const rows: IndexChunkRow[] = []
    for (const [index, chunk] of kept.entries()) {
      let triggers = extractTriggers({
        sectionText: chunk.chunk_text,
        filePath: rel,
        ...(note.raw !== undefined ? { noteMeta: note.raw } : {}),
        ...(this.frameworkVocabulary.length > 0
          ? { manifestVocabulary: { frameworks: this.frameworkVocabulary } }
          : {}),
      })
      triggers = await this.refineWithLlm(chunk.chunk_text, triggers)
      rows.push({
        [MILVUS_FIELDS.chunkId]: newIds[index] as number,
        [MILVUS_FIELDS.sourcePath]: chunk.source_path.slice(0, SOURCE_PATH_MAX_CHARS),
        [MILVUS_FIELDS.sectionHeader]: chunk.section_header.slice(0, SECTION_HEADER_MAX_CHARS),
        [MILVUS_FIELDS.chunkText]: chunk.chunk_text.slice(0, CHUNK_TEXT_MAX_CHARS),
        [MILVUS_FIELDS.vault]: this.vault.path.slice(0, VAULT_MAX_CHARS),
        [MILVUS_FIELDS.scope]: scope,
        [MILVUS_FIELDS.triggerExtensions]: triggers.trigger_extensions,
        [MILVUS_FIELDS.triggerFrameworks]: triggers.trigger_frameworks,
        [MILVUS_FIELDS.wakeKeywords]: triggers.wake_keywords,
        [MILVUS_FIELDS.denseVector]: vectors[index] as number[],
        [MILVUS_FIELDS.updatedAt]: Math.round(mtimeMs),
      })
    }

    // Chunk ids ignore content (they hash path/header/part/model/dim),
    // so a content change usually keeps the same ids: delete the file's
    // OLD ids wholesale, then insert the fresh rows. Insert-over-existing
    // id would leave duplicate visible entities on lite.
    const staleIds = stored?.chunkIds ?? []
    try {
      await this.enqueueWrite(async () => {
        if (staleIds.length > 0) {
          assertOk(await this.writer.delete({
            collection_name: this.collectionName,
            ids: staleIds,
          }), 'indexer delete')
        }
        if (rows.length > 0) {
          assertOk(await this.writer.insert({
            collection_name: this.collectionName,
            data: rows,
          }), 'indexer insert')
        }
      })
    } catch (error) {
      // Milvus offline: leave the state entry untouched so the content
      // diff re-dirty's this file on the next run (task spec).
      this.errors += 1
      this.log(`write failed for ${rel} (state kept dirty): ${describeError(error)}`)
      return 'unchanged'
    }

    this.state.files[rel] = { contentHash: hash, mtimeMs, chunkIds: newIds }
    this.saveState()
    this.indexed += 1
    return 'indexed'
  }

  // Drop a file's chunks and state entry: removals, archived notes, and
  // reserved-path corrections all funnel here.
  private async applyRemovedFile(rel: string): Promise<FileOutcome> {
    const stored = this.state.files[rel]
    if (stored === undefined) {
      return 'unchanged'
    }
    if (stored.chunkIds.length > 0) {
      await this.enqueueWrite(async () => {
        assertOk(await this.writer.delete({
          collection_name: this.collectionName,
          ids: stored.chunkIds,
        }), 'indexer delete-stale')
      })
    }
    delete this.state.files[rel]
    this.saveState()
    return 'purged'
  }

  // Recursive walk of `<vault>/markdown/**/*.md`. Dotfiles, dot dirs, and
  // reserved non-indexed names (.INTENTS.md, DREAMS.md, *_history.md)
  // never enter the index.
  private listMarkdownFiles(): string[] {
    const files: string[] = []
    const walk = (dirAbsolute: string, relDir: string): void => {
      const entries = this.fsLike.listDirectory(dirAbsolute)
      if (entries === null) {
        return
      }
      for (const entry of entries) {
        if (entry.directory) {
          if (!entry.name.startsWith('.')) {
            walk(join(dirAbsolute, entry.name), `${relDir}/${entry.name}`)
          }
          continue
        }
        if (!entry.name.endsWith('.md') || entry.name.startsWith('.')
          || isReservedNonIndexed(entry.name)) {
          continue
        }
        files.push(`${relDir}/${entry.name}`)
      }
    }
    walk(markdownDir(this.vault.path), 'markdown')
    files.sort()
    if (files.length > MAX_FILES_PER_VAULT) {
      this.log(`${this.vault.path}: ${files.length} files exceeds cap ${MAX_FILES_PER_VAULT}; tail dropped`)
      return files.slice(0, MAX_FILES_PER_VAULT)
    }
    return files
  }

  // A stored state built for a different model, width, or schema version
  // means every chunkId is (about to be) wrong: force full re-embed, and
  // the per-file stale-delete removes the old-model rows.
  private stateNeedsFullRebuild(state: IndexState): boolean {
    return state.version !== INDEX_STATE_VERSION
      || state.modelId !== this.embedder.modelId
      || state.vectorDim !== this.embedder.dim
  }

  private readStateFromDisk(): IndexState {
    const fresh = (): IndexState => ({
      version: INDEX_STATE_VERSION,
      modelId: this.embedder.modelId,
      vectorDim: this.embedder.dim,
      files: {},
    })
    const raw = this.fsLike.readFile(this.stateFilePath)
    if (raw === null) {
      return fresh()
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IndexState>
      const files = (parsed.files ?? {}) as Record<string, IndexFileState>
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
        vectorDim: typeof parsed.vectorDim === 'number' ? parsed.vectorDim : -1,
        files,
      }
    } catch (error) {
      this.log(`state file unreadable (${this.stateFilePath}): ${describeError(error)}; starting fresh`)
      return fresh()
    }
  }

  // Atomic state write: tmp file plus rename inside the metadata dir.
  // The model stamp (version/modelId/vectorDim) is NOT rewritten here:
  // it flips only after a full run finishes clean (end of reindex), so a
  // crash mid-migration leaves the old stamp and the next run re-forces
  // the full rebuild instead of stranding old-model rows.
  private saveState(): void {
    const statePath = this.stateFilePath
    this.fsLike.mkdirp(metadataDir(this.vault.path))
    const tmpPath = `${statePath}.tmp`
    this.fsLike.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`)
    this.fsLike.rename(tmpPath, statePath)
  }

  // Watcher events only mark dirt; the debounce window collapses Obsidian's
  // save churn (write+rename emits several events per save).
  private onWatchEvent(fileName: string | null): void {
    if (this.stopped) {
      return
    }
    if (fileName === null) {
      this.dirtyAll = true
    } else {
      const rel = this.normalizeRel(`markdown/${fileName.replace(/\\/g, '/')}`)
      if (rel === null) {
        return
      }
      this.dirty.add(rel)
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flushDirty()
    }, WATCH_DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  private flushDirty(): void {
    if (this.stopped) {
      return
    }
    if (this.dirtyAll) {
      this.dirtyAll = false
      this.dirty.clear()
      void this.reindex().catch((error: unknown) => {
        this.errors += 1
        this.log(`watcher reindex failed: ${describeError(error)}`)
      })
      return
    }
    const rels = [...this.dirty]
    this.dirty.clear()
    for (const rel of rels) {
      void this.indexFile(rel).catch((error: unknown) => {
        this.errors += 1
        this.log(`watcher index of ${rel} failed: ${describeError(error)}`)
      })
    }
  }

  // 30 s stat sweep: any mtime drift or file-count drift re-dirties the
  // vault. Content-hash diffs in processFile make duplicate dirt cheap.
  private pollStats(): void {
    if (this.stopped) {
      return
    }
    const files = this.listMarkdownFiles()
    let drifted = files.length !== Object.keys(this.state.files).length
    for (const rel of files) {
      const stored = this.state.files[rel]
      const mtime = this.fsLike.stat(join(this.vault.path, rel))?.mtimeMs
      if (mtime === undefined || stored === undefined || mtime !== stored.mtimeMs) {
        drifted = true
        break
      }
    }
    if (drifted) {
      this.dirtyAll = true
      if (this.debounceTimer === null) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null
          this.flushDirty()
        }, WATCH_DEBOUNCE_MS)
        this.debounceTimer.unref?.()
      }
    }
  }

  // Accept vault-relative or vault-absolute paths; anything outside
  // <vault>/markdown or not a candidate .md file normalizes to null.
  private normalizeRel(input: string): string | null {
    let rel = input.replace(/\\/g, '/')
    if (rel.startsWith(`${this.vault.path.replace(/\\/g, '/')}/`)) {
      rel = rel.slice(this.vault.path.length + 1)
    }
    if (!rel.startsWith('markdown/') || !rel.endsWith('.md')) {
      return null
    }
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (base.startsWith('.') || isReservedNonIndexed(base)) {
      return null
    }
    return rel
  }

  // Optional Q3 upgrade: an OpenAI-compatible chat completion asks for
  // {wake_keywords, trigger_frameworks} JSON per chunk and MERGES onto the
  // heuristics. Every failure path (no key, bad status, bad JSON) falls
  // back to the heuristics silently with the llmErrors counter; three
  // consecutive failures open the circuit for the rest of the run.
  private async refineWithLlm(chunkText: string, base: {
    trigger_extensions: string[]
    trigger_frameworks: string[]
    wake_keywords: string[]
  }): Promise<typeof base> {
    if (!this.llm.enabled || this.fetchImpl === null || this.llmCircuitOpen) {
      return base
    }
    const apiKey = this.llm.apiKeyEnv !== undefined ? this.env[this.llm.apiKeyEnv] : ''
    if (this.llm.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === '')) {
      return base
    }

    try {
      const prompt = 'Extract wake keywords and frameworks for this memory note chunk. '
        + 'Reply with ONLY a JSON object of the shape '
        + '{"wake_keywords": ["...", "..."], "trigger_frameworks": ["...", "..."]}. '
        + 'Lowercase terms only.\n\n---\n'
        + chunkText.slice(0, LLM_INPUT_CHAR_CAP)
      const response = await this.fetchImpl(
        `${this.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey !== undefined && apiKey !== ''
              ? { authorization: `Bearer ${apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.llm.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          }),
          ...(typeof AbortSignal.timeout === 'function'
            ? { signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS) }
            : {}),
        },
      )
      if (response.ok === false || (response.ok === undefined && (response.status ?? 0) >= 400)) {
        throw new Error(`llm status ${String(response.status ?? 'unknown')}`)
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error('llm response has no message content')
      }
      const parsed = JSON.parse(content.replace(/^```(?:json)?[ \t]*\n?/i, '').replace(/```[ \t]*$/, '').trim()) as {
        wake_keywords?: unknown
        trigger_frameworks?: unknown
      }
      const wake = mergeLists(base.wake_keywords, stringEntries(parsed.wake_keywords))
      const frameworks = mergeLists(base.trigger_frameworks, stringEntries(parsed.trigger_frameworks))
      this.llmConsecutiveFailures = 0
      return { ...base, wake_keywords: wake, trigger_frameworks: frameworks }
    } catch (error) {
      this.llmErrors += 1
      this.llmConsecutiveFailures += 1
      if (this.llmConsecutiveFailures >= LLM_FAILURE_CIRCUIT && !this.llmCircuitOpen) {
        this.llmCircuitOpen = true
        this.log(`llm refinement disabled for this run after ${this.llmConsecutiveFailures} `
          + `consecutive failures: ${describeError(error)}`)
      }
      return base
    }
  }
}

/** Aggregates one IndexerManager's per-vault progress. */
export interface IndexerManagerOptions {
  vaults: readonly VaultConfig[]
  embedder: Embedder
  writer: IndexWriter
  fs?: IndexerFs
  watchFactory?: WatchFactory
  llm?: LlmRefineConfig
  fetch?: LlmFetch
  env?: Record<string, string | undefined>
  frameworkVocabulary?: readonly string[]
  collectionName?: string
  log?: (message: string) => void
}

/**
 * IndexerManager runs one VaultIndexer per registered vault: start()
 * (background full-scan plus watchers), reindexAll() (card and audit
 * manual trigger), the write-through indexFile(vaultPath, rel) hook, and
 * summed progress. Lookup is by the exact vault path (registry paths are
 * already realpath-canonical).
 */
export class IndexerManager {
  private readonly indexers = new Map<string, VaultIndexer>()

  constructor(options: IndexerManagerOptions) {
    for (const vault of options.vaults) {
      this.indexers.set(vault.path, new VaultIndexer({ ...options, vault }))
    }
  }

  /** Start every vault indexer (full-scan background + watch). */
  start(): void {
    for (const indexer of this.indexers.values()) {
      indexer.start()
    }
  }

  /** Stop every watcher and timer. */
  stop(): void {
    for (const indexer of this.indexers.values()) {
      indexer.stop()
    }
  }

  /** ReindexAll re-diffs every vault sequentially (single writer). */
  async reindexAll(): Promise<void> {
    for (const indexer of this.indexers.values()) {
      await indexer.reindex()
    }
  }

  /**
   * IndexFile is the write-through hook: vaultPath must be a registered
   * vault; returns false when it is not.
   */
  async indexFile(vaultPath: string, relPath: string): Promise<boolean> {
    const indexer = this.indexers.get(vaultPath)
    if (indexer === undefined) {
      return false
    }
    await indexer.indexFile(relPath)
    return true
  }

  /** Progress sums the per-vault counters. */
  progress(): IndexProgress {
    const total: IndexProgress = { indexed: 0, pending: 0, errors: 0, llmErrors: 0 }
    for (const indexer of this.indexers.values()) {
      const vaultProgress = indexer.progress
      total.indexed += vaultProgress.indexed
      total.pending += vaultProgress.pending
      total.errors += vaultProgress.errors
      total.llmErrors += vaultProgress.llmErrors
    }
    return total
  }

  /** VaultProgress reports one vault's counters; null when unmanaged. */
  vaultProgress(vaultPath: string): IndexProgress | null {
    return this.indexers.get(vaultPath)?.progress ?? null
  }
}

// Merge heuristic and LLM lists: heuristic-first order, deduped.
function mergeLists(base: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...base, ...extra.map((value) => value.trim().toLowerCase()).filter((value) => value !== '')])]
}

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
