/**
 * Indexer keeps every registered vault's chunks in the `obsidian_mem`
 * collection (TASK-023): per-vault diff state under
 * `<vault>/.obsidian-mem/metadata/obsidian-mem-state.json`, the parse →
 * chunk → trigger-extract → embed → delete-stale → insert pipeline, the
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
import type { VaultConfig } from '../../core/lib/index.js';
import type { Embedder } from './embedder.js';
import type { LlmFetch, LlmRefineConfig } from './llm-refine.js';
export type { LlmFetch, LlmRefineConfig } from './llm-refine.js';
/**
 * INDEX_STATE_VERSION is the schema version of the per-vault state file.
 * 2: state keys became vault-root-relative when the note tree moved out of
 * `markdown/` to the vault root. A vault still stamped 1 re-embeds once:
 * its stale `markdown/…` keys match no file on disk, so the run's stale
 * delete purges their old chunk ids from Milvus before the root-relative
 * keys are inserted fresh.
 */
export declare const INDEX_STATE_VERSION = 2;
/** State file name inside `<vault>/.obsidian-mem/metadata/`. */
export declare const STATE_FILE_NAME = "obsidian-mem-state.json";
/** Suffix saveState appends to the tmp file before the rename onto the state file. */
export declare const STATE_FILE_TMP_SUFFIX = ".tmp";
/**
 * IndexStatePath is the ONE definition of the per-vault state file location
 * (`<vault>/.obsidian-mem/metadata/obsidian-mem-state.json`). The indexer
 * writes it, the audit reads it, and the service's forced-reindex reset
 * deletes it; all three call here.
 */
export declare function indexStatePath(vaultPath: string): string;
/** Watcher debounce window; memsearch watchdog value. */
export declare const WATCH_DEBOUNCE_MS = 1500;
/**
 * POLL_INTERVAL_MS is the default stat-sweep interval. The sweep is the
 * safety net for a watcher that died or dropped events (nodeWatchFactory
 * closes its handle on an fs.watch error and nothing re-arms it), not only
 * the fallback when recursive watching is unavailable, so it stays on even
 * beside a live watcher; VaultIndexerOptions.pollIntervalMs overrides it and
 * 0 turns it off. It is stat-only work: no reads, no embeds, no Milvus calls.
 */
export declare const POLL_INTERVAL_MS = 30000;
/** Hard cap on indexed files per vault; the walk stops past it. */
export declare const MAX_FILES_PER_VAULT = 2000;
/** Hard cap on chunks indexed per file; later sections are dropped. */
export declare const MAX_CHUNKS_PER_FILE = 128;
/** Per-file record in the vault state file. */
export interface IndexFileState {
    contentHash: string;
    mtimeMs: number;
    chunkIds: number[];
}
/** The `<vault>/.obsidian-mem/metadata/obsidian-mem-state.json` document. */
export interface IndexState {
    version: number;
    /** Embedding model id the stored chunkIds were hashed with. */
    modelId: string;
    /** Vector width the stored vectors were built at. */
    vectorDim: number;
    /** Vault-root-relative path ("note.md" or "sub/note.md", posix separators) keyed. */
    files: Record<string, IndexFileState>;
}
/** Live progress counters consumed by ui status and memory_audit. */
export interface IndexProgress {
    /** Files fully (re)indexed since construction; cumulative. */
    indexed: number;
    /** Files queued: watcher-dirty now plus the current run's remainder. */
    pending: number;
    /** Cumulative failures: Milvus writes, parses, per-file errors. */
    errors: number;
    /** Cumulative LLM refinement failures (fallbacks to heuristics). */
    llmErrors: number;
}
/** One inserted chunk row keyed by the MILVUS_FIELDS names. */
export type IndexChunkRow = Record<string, unknown>;
/** The write slice of a Milvus client the indexer needs. */
export interface IndexWriter {
    insert(request: {
        collection_name: string;
        data: IndexChunkRow[];
    }): Promise<unknown>;
    delete(request: {
        collection_name: string;
        ids: number[];
    }): Promise<unknown>;
}
/** A directory entry as the vault walk needs it. */
export interface IndexDirEntry {
    name: string;
    directory: boolean;
}
/**
 * IndexerFs is the fs seam the indexer walks and writes through. All
 * paths reaching it are absolute; tests use an in-memory tree.
 */
export interface IndexerFs {
    /** Lists a directory; null when missing or unreadable (skip it). */
    listDirectory(path: string): IndexDirEntry[] | null;
    /** Reads a UTF-8 file; null when the file is gone. */
    readFile(path: string): string | null;
    /** Writes a UTF-8 file, replacing any previous content. */
    writeFile(path: string, contents: string): void;
    /** Atomically replaces `to` with `from` (same filesystem). */
    rename(from: string, to: string): void;
    /** File stat mtime in ms; null when the path is gone. */
    stat(path: string): {
        mtimeMs: number;
    } | null;
    /** Creates the directory and any missing parents. */
    mkdirp(path: string): void;
}
/** Node implementation of IndexerFs over node:fs. */
export declare const nodeIndexerFs: IndexerFs;
/** Handle returned by a WatchFactory; close() releases the OS watch. */
export interface WatchHandle {
    close(): void;
}
/** Watch callback: changed paths relative to the watched dir, or null. */
export type WatchListener = (fileName: string | null) => void;
/**
 * WatchFactory starts a recursive watch on `path`; null means recursive
 * watching is unavailable and the indexer falls back to stat polling.
 * The listener receives changed paths relative to `path`, or null for an
 * unattributable change (rescan the vault).
 */
export type WatchFactory = (path: string, listener: WatchListener) => WatchHandle | null;
/** Node recursive fs.watch implementation of WatchFactory. */
export declare const nodeWatchFactory: WatchFactory;
/** Options for one VaultIndexer. */
export interface VaultIndexerOptions {
    vault: VaultConfig;
    embedder: Embedder;
    writer: IndexWriter;
    /** Fs seam; default nodeIndexerFs. */
    fs?: IndexerFs;
    /** Watch seam; default nodeWatchFactory. */
    watchFactory?: WatchFactory;
    /** Optional LLM refinement pass; absent or disabled means heuristics only. */
    llm?: LlmRefineConfig;
    /** Fetch seam for the LLM pass. */
    fetch?: LlmFetch;
    /** Env for the LLM api-key lookup; default process.env. */
    env?: Record<string, string | undefined>;
    /** Workspace-manifest framework labels offered to trigger extraction. */
    frameworkVocabulary?: readonly string[];
    collectionName?: string;
    /** Stat-sweep interval in ms; default POLL_INTERVAL_MS, 0 disables the sweep. */
    pollIntervalMs?: number;
    log?: (message: string) => void;
}
/** Outcome counters of one reindex() run. */
export interface IndexRunSummary {
    /** Files re-embedded and inserted. */
    indexed: number;
    /** Chunks purged: removed files plus archived notes. */
    purged: number;
    /** Failures this run (also in the cumulative progress.errors). */
    errors: number;
}
/**
 * VaultIndexer owns one vault's state file, pipeline, watcher, and write
 * queue. Constructing starts nothing: start() runs the background
 * full-scan and arms the watcher, reindex()/indexFile() are the manual
 * and write-through entries. The Milvus collection must already exist
 * and be loaded (schema.ts ensureCollection + loadCollectionSync); this
 * module never creates or loads it.
 */
export declare class VaultIndexer {
    readonly vault: VaultConfig;
    private readonly embedder;
    private readonly writer;
    private readonly fsLike;
    private readonly watchFactory;
    private readonly llmRefiner;
    private readonly frameworkVocabulary;
    private readonly collectionName;
    private readonly pollIntervalMs;
    private readonly vaultKey;
    private readonly log;
    private state;
    private indexed;
    private errors;
    private runRemaining;
    private readonly dirty;
    private dirtyAll;
    private debounceTimer;
    private pollTimer;
    private watchHandle;
    private stopped;
    private readonly enqueueOp;
    private readonly enqueueWrite;
    constructor(options: VaultIndexerOptions);
    /** Path of the vault's state file. */
    get stateFilePath(): string;
    /** Progress snapshots the ui status card and memory_audit read. */
    get progress(): IndexProgress;
    /**
     * Start arms activation triggers: a background full-scan (not awaited)
     * plus the debounced watcher and the POLL_INTERVAL_MS stat sweep (see
     * pollIntervalMs). Read-only vaults are indexed too: recall works, only
     * writes are refused.
     */
    start(): void;
    /** Stop releases the watcher and timers; queued work is dropped. */
    stop(): void;
    /** Reindex diffs the whole vault against the state file and applies it. */
    reindex(): Promise<IndexRunSummary>;
    /**
     * IndexFile is the write-through hook for memory_write: re-index one
     * vault-relative (or vault-absolute) path immediately. Missing files
     * are treated as removals.
     */
    indexFile(relPath: string): Promise<void>;
    private processFile;
    private deleteChunks;
    private deleteRows;
    private buildRows;
    private applyRemovedFile;
    private listMarkdownFiles;
    private stateNeedsFullRebuild;
    private readStateFromDisk;
    private saveState;
    private onWatchEvent;
    private scheduleFlush;
    private flushDirty;
    private pollStats;
    private normalizeRel;
}
/**
 * IndexerManagerOptions is every VaultIndexerOptions field except `vault`,
 * plus the vault list: the manager hands the same shared seams (embedder,
 * writer, fs, watchers, LLM, budgets) to each per-vault indexer, so the
 * option shape has one definition instead of a second copy to keep in step.
 */
export type IndexerManagerOptions = Omit<VaultIndexerOptions, 'vault'> & {
    vaults: readonly VaultConfig[];
};
/**
 * IndexerManager runs one VaultIndexer per registered vault: start()
 * (background full-scan plus watchers), reindexAll() (card and audit
 * manual trigger), the write-through indexFile(vaultPath, rel) hook, and
 * summed progress. Lookup is by the exact vault path (registry paths are
 * already realpath-canonical).
 */
export declare class IndexerManager {
    private readonly indexers;
    constructor(options: IndexerManagerOptions);
    /** Start every vault indexer (full-scan background + watch). */
    start(): void;
    /** Stop every watcher and timer. */
    stop(): void;
    /** ReindexAll re-diffs every vault sequentially (single writer). */
    reindexAll(): Promise<void>;
    /**
     * IndexFile is the write-through hook: vaultPath must be a registered
     * vault; returns false when it is not.
     */
    indexFile(vaultPath: string, relPath: string): Promise<boolean>;
    /** Progress sums the per-vault counters. */
    progress(): IndexProgress;
    /** VaultProgress reports one vault's counters; null when unmanaged. */
    vaultProgress(vaultPath: string): IndexProgress | null;
}
//# sourceMappingURL=indexer.d.ts.map
