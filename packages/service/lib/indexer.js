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
import { watch as fsWatch } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkId, chunkMarkdown, contentHash, extractTriggers, isArchived, isReservedNonIndexed, isScopeType, markdownDir, metadataDir, MILVUS_COLLECTION, MILVUS_FIELDS, MILVUS_SCALAR_MAX_LENGTHS, parseNote, SCOPE_GLOBAL, stripNoise, } from '../../core/lib/index.js';
import { describeError } from './errors.js';
import { LlmRefiner } from './llm-refine.js';
import { assertOk } from './milvus/ok.js';
import { createSerialQueue } from './serial-queue.js';
/** Schema version of the per-vault state file. */
export const INDEX_STATE_VERSION = 1;
/** State file name inside `<vault>/metadata/`. */
export const STATE_FILE_NAME = 'obsidian-mem-state.json';
/** Watcher debounce window; memsearch watchdog value. */
export const WATCH_DEBOUNCE_MS = 1500;
/**
 * POLL_INTERVAL_MS is the default stat-sweep interval. The sweep is the
 * safety net for a watcher that died or dropped events (nodeWatchFactory
 * closes its handle on an fs.watch error and nothing re-arms it), not only
 * the fallback when recursive watching is unavailable, so it stays on even
 * beside a live watcher; VaultIndexerOptions.pollIntervalMs overrides it and
 * 0 turns it off. It is stat-only work: no reads, no embeds, no Milvus calls.
 */
export const POLL_INTERVAL_MS = 30_000;
/** Hard cap on indexed files per vault; the walk stops past it. */
export const MAX_FILES_PER_VAULT = 2000;
/** Hard cap on chunks indexed per file; later sections are dropped. */
export const MAX_CHUNKS_PER_FILE = 128;
/** Node implementation of IndexerFs over node:fs. */
export const nodeIndexerFs = {
    listDirectory(path) {
        try {
            return readdirSync(path, { withFileTypes: true })
                .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
        }
        catch {
            return null;
        }
    },
    readFile(path) {
        try {
            return readFileSync(path, 'utf8');
        }
        catch {
            return null;
        }
    },
    writeFile(path, contents) {
        writeFileSync(path, contents, 'utf8');
    },
    rename(from, to) {
        renameSync(from, to);
    },
    stat(path) {
        try {
            return { mtimeMs: statSync(path).mtimeMs };
        }
        catch {
            return null;
        }
    },
    mkdirp(path) {
        mkdirSync(path, { recursive: true });
    },
};
/** Node recursive fs.watch implementation of WatchFactory. */
export const nodeWatchFactory = (path, listener) => {
    try {
        const watcher = fsWatch(path, { recursive: true }, (_event, fileName) => {
            listener(typeof fileName === 'string' ? fileName : null);
        });
        watcher.on('error', () => {
            // A dead watcher is handled by the 30 s stat poll the indexer also
            // runs; close so the broken handle is not mistaken for a live watch.
            try {
                watcher.close();
            }
            catch {
                // already closed
            }
        });
        return { close: () => { watcher.close(); } };
    }
    catch {
        return null;
    }
};
/**
 * VaultIndexer owns one vault's state file, pipeline, watcher, and write
 * queue. Constructing starts nothing: start() runs the background
 * full-scan and arms the watcher, reindex()/indexFile() are the manual
 * and write-through entries. The Milvus collection must already exist
 * and be loaded (schema.ts ensureCollection + loadCollectionSync); this
 * module never creates or loads it.
 */
export class VaultIndexer {
    vault;
    embedder;
    writer;
    fsLike;
    watchFactory;
    llmRefiner;
    frameworkVocabulary;
    collectionName;
    pollIntervalMs;
    vaultKey;
    log;
    state;
    indexed = 0;
    errors = 0;
    runRemaining = 0;
    dirty = new Set();
    dirtyAll = false;
    debounceTimer = null;
    pollTimer = null;
    watchHandle = null;
    stopped = false;
    // Every index operation runs one at a time: the state file and the
    // dirty queue are shared between reindex(), indexFile(), and the
    // watcher flush, and there is exactly one writer to lite.
    enqueueOp = createSerialQueue();
    // Separate mutation queue: every delete/insert pair reaches Milvus in
    // issue order on its own, so a slow embed never idles the writer.
    enqueueWrite = createSerialQueue();
    constructor(options) {
        this.vault = options.vault;
        this.embedder = options.embedder;
        this.writer = options.writer;
        this.fsLike = options.fs ?? nodeIndexerFs;
        this.watchFactory = options.watchFactory ?? nodeWatchFactory;
        this.log = options.log ?? ((message) => console.warn(`[obsidian-mem indexer] ${message}`));
        this.llmRefiner = new LlmRefiner({
            ...(options.llm !== undefined ? { config: options.llm } : {}),
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
            log: this.log,
        });
        this.frameworkVocabulary = options.frameworkVocabulary ?? [];
        this.collectionName = options.collectionName ?? MILVUS_COLLECTION;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        // The stored and hashed vault identity: one truncation of the path, so
        // the chunkId input and the vault column can never disagree.
        this.vaultKey = options.vault.path.slice(0, MILVUS_SCALAR_MAX_LENGTHS.vault);
        this.state = this.readStateFromDisk();
    }
    /** Path of the vault's state file. */
    get stateFilePath() {
        return join(metadataDir(this.vault.path), STATE_FILE_NAME);
    }
    /** Progress snapshots the ui status card and memory_audit read. */
    get progress() {
        return {
            indexed: this.indexed,
            pending: this.runRemaining + this.dirty.size,
            errors: this.errors,
            llmErrors: this.llmRefiner.failures,
        };
    }
    /**
     * Start arms activation triggers: a background full-scan (not awaited)
     * plus the debounced watcher and the POLL_INTERVAL_MS stat sweep (see
     * pollIntervalMs). Read-only vaults are indexed too: recall works, only
     * writes are refused.
     */
    start() {
        this.stopped = false;
        this.watchHandle = this.watchFactory(markdownDir(this.vault.path), (fileName) => {
            this.onWatchEvent(fileName);
        });
        if (this.pollTimer === null && this.pollIntervalMs > 0) {
            this.pollTimer = setInterval(() => {
                this.pollStats();
            }, this.pollIntervalMs);
            this.pollTimer.unref?.();
        }
        void this.reindex().catch((error) => {
            this.errors += 1;
            this.log(`background reindex failed for ${this.vault.path}: ${describeError(error)}`);
        });
    }
    /** Stop releases the watcher and timers; queued work is dropped. */
    stop() {
        this.stopped = true;
        this.watchHandle?.close();
        this.watchHandle = null;
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.dirty.clear();
        this.dirtyAll = false;
    }
    /** Reindex diffs the whole vault against the state file and applies it. */
    reindex() {
        return this.enqueueOp(async () => {
            const started = Date.now();
            const files = this.listMarkdownFiles();
            const baseline = this.state;
            const forceFull = this.stateNeedsFullRebuild(baseline);
            if (forceFull) {
                this.log(`model/dim/version drift for ${this.vault.path}: full re-embed`);
            }
            const summary = { indexed: 0, purged: 0, errors: this.errors };
            const present = new Set(files);
            this.runRemaining = files.length;
            this.llmRefiner.resetRun();
            for (const removedRel of Object.keys(baseline.files)) {
                if (!present.has(removedRel)) {
                    try {
                        if (await this.applyRemovedFile(removedRel) === 'purged') {
                            summary.purged += 1;
                        }
                    }
                    catch (error) {
                        // Offline deletes keep the state entry; the next run retries.
                        this.errors += 1;
                        this.log(`delete of ${removedRel} failed: ${describeError(error)}`);
                    }
                }
            }
            for (const rel of files) {
                this.runRemaining -= 1;
                try {
                    const outcome = await this.processFile(rel, forceFull);
                    if (outcome === 'indexed') {
                        summary.indexed += 1;
                    }
                    else if (outcome === 'purged') {
                        summary.purged += 1;
                    }
                }
                catch (error) {
                    this.errors += 1;
                    this.log(`file ${rel} failed: ${describeError(error)}`);
                }
            }
            summary.errors = this.errors - summary.errors;
            if (summary.errors === 0) {
                // Stamp the model this state now reflects; see saveState's note
                // on why the stamp only moves after a clean full run.
                this.state.version = INDEX_STATE_VERSION;
                this.state.modelId = this.embedder.modelId;
                this.state.vectorDim = this.embedder.dim;
                this.saveState();
            }
            this.log(`reindex ${this.vault.path}: ${summary.indexed} indexed, `
                + `${summary.purged} purged, ${summary.errors} errors in ${Date.now() - started} ms`);
            return summary;
        });
    }
    /**
     * IndexFile is the write-through hook for memory_write: re-index one
     * vault-relative (or vault-absolute) path immediately. Missing files
     * are treated as removals.
     */
    indexFile(relPath) {
        const rel = this.normalizeRel(relPath);
        if (rel === null) {
            return Promise.resolve();
        }
        return this.enqueueOp(async () => {
            await this.processFile(rel, false);
        });
    }
    // Diff one file against the state baseline. 'indexed' means the file
    // was re-embedded and inserted; 'purged' means its chunks were
    // deleted (removed from disk or archived); 'unchanged' touched nothing.
    async processFile(rel, forceFull) {
        const absolute = join(this.vault.path, rel);
        const text = this.fsLike.readFile(absolute);
        if (text === null) {
            return this.applyRemovedFile(rel);
        }
        const hash = contentHash(text);
        const stored = this.state.files[rel];
        if (!forceFull && stored !== undefined && stored.contentHash === hash) {
            return 'unchanged';
        }
        const note = parseNote(text);
        const mtimeMs = this.fsLike.stat(absolute)?.mtimeMs ?? Date.now();
        // Archived notes stay on disk for audit and dreams but leave the
        // index. The state entry is KEPT (with the hash and no chunk ids)
        // so the poll and later runs see the file as settled; un-archiving
        // edits the file, the contentHash drifts, and the note re-indexes.
        if (isArchived(note.meta)) {
            const archivedStaleIds = stored?.chunkIds ?? [];
            if (archivedStaleIds.length > 0) {
                try {
                    await this.deleteChunks(archivedStaleIds, 'indexer delete-archived');
                }
                catch (error) {
                    this.errors += 1;
                    this.log(`archived purge failed for ${rel} (state kept dirty): ${describeError(error)}`);
                    return 'unchanged';
                }
            }
            this.state.files[rel] = { contentHash: hash, mtimeMs, chunkIds: [] };
            this.saveState();
            return 'purged';
        }
        const chunks = chunkMarkdown({ source_path: rel, text });
        if (chunks.length > MAX_CHUNKS_PER_FILE) {
            this.log(`${rel}: ${chunks.length} chunks truncated to ${MAX_CHUNKS_PER_FILE}`);
        }
        const kept = chunks.slice(0, MAX_CHUNKS_PER_FILE);
        const vectors = await this.embedder.embedPassages(kept.map((chunk) => stripNoise(chunk.chunk_text)));
        if (vectors.length !== kept.length) {
            throw new Error(`embedder returned ${vectors.length} vectors for ${kept.length} chunks`);
        }
        const scope = isScopeType(note.meta.type) ? note.meta.type : SCOPE_GLOBAL;
        const newIds = kept.map((chunk) => chunkId({
            vault: this.vaultKey,
            source_path: rel,
            header_hash: chunk.header_hash,
            part: chunk.part,
            modelId: this.embedder.modelId,
            vectorDim: this.embedder.dim,
        }));
        const rows = await this.buildRows({
            rel, note, scope, mtimeMs, chunks: kept, vectors, ids: newIds,
        });
        // Chunk ids ignore content (they hash path/header/part/model/dim),
        // so a content change usually keeps the same ids: delete the file's
        // OLD ids wholesale, then insert the fresh rows. Insert-over-existing
        // id would leave duplicate visible entities on lite.
        const staleIds = stored?.chunkIds ?? [];
        try {
            await this.enqueueWrite(async () => {
                if (staleIds.length > 0) {
                    await this.deleteRows(staleIds, 'indexer delete');
                }
                if (rows.length > 0) {
                    assertOk(await this.writer.insert({
                        collection_name: this.collectionName,
                        data: rows,
                    }), 'indexer insert');
                }
            });
        }
        catch (error) {
            // Milvus offline: leave the state entry untouched so the content
            // diff re-dirty's this file on the next run (task spec).
            this.errors += 1;
            this.log(`write failed for ${rel} (state kept dirty): ${describeError(error)}`);
            return 'unchanged';
        }
        this.state.files[rel] = { contentHash: hash, mtimeMs, chunkIds: newIds };
        this.saveState();
        this.indexed += 1;
        return 'indexed';
    }
    // One chunk purge, queued onto the single Milvus mutation lane: lite
    // tolerates concurrent readers but not concurrent writers (findings §3).
    deleteChunks(ids, what) {
        return this.enqueueWrite(() => this.deleteRows(ids, what));
    }
    // DeleteRows runs the delete itself. A caller already holding the
    // mutation lane (the delete-then-insert pair) calls it directly: queuing
    // from inside the lane would wait on itself.
    async deleteRows(ids, what) {
        assertOk(await this.writer.delete({
            collection_name: this.collectionName,
            ids: [...ids],
        }), what);
    }
    // One insert row per kept chunk. Stored scalars are clamped to the
    // column widths core declares (MILVUS_SCALAR_MAX_LENGTHS), and the
    // trigger lists are the core heuristics plus the optional LLM merge.
    async buildRows(input) {
        const { sourcePath, sectionHeader, chunkText } = MILVUS_SCALAR_MAX_LENGTHS;
        const rows = [];
        for (const [index, chunk] of input.chunks.entries()) {
            // The author's own vocabulary reaches the heuristics as the parsed
            // frontmatter record (Note.raw); gray-matter stays a core concern.
            let triggers = extractTriggers({
                sectionText: chunk.chunk_text,
                filePath: input.rel,
                ...(input.note.raw !== undefined ? { noteMeta: input.note.raw } : {}),
                ...(this.frameworkVocabulary.length > 0
                    ? { manifestVocabulary: { frameworks: this.frameworkVocabulary } }
                    : {}),
            });
            triggers = await this.llmRefiner.refine(chunk.chunk_text, triggers);
            rows.push({
                [MILVUS_FIELDS.chunkId]: input.ids[index],
                [MILVUS_FIELDS.sourcePath]: chunk.source_path.slice(0, sourcePath),
                [MILVUS_FIELDS.sectionHeader]: chunk.section_header.slice(0, sectionHeader),
                [MILVUS_FIELDS.chunkText]: chunk.chunk_text.slice(0, chunkText),
                [MILVUS_FIELDS.vault]: this.vaultKey,
                [MILVUS_FIELDS.scope]: input.scope,
                [MILVUS_FIELDS.triggerExtensions]: triggers.trigger_extensions,
                [MILVUS_FIELDS.triggerFrameworks]: triggers.trigger_frameworks,
                [MILVUS_FIELDS.wakeKeywords]: triggers.wake_keywords,
                [MILVUS_FIELDS.denseVector]: input.vectors[index],
                [MILVUS_FIELDS.updatedAt]: Math.round(input.mtimeMs),
            });
        }
        return rows;
    }
    // Drop a file's chunks and state entry: removals, archived notes, and
    // reserved-path corrections all funnel here.
    async applyRemovedFile(rel) {
        const stored = this.state.files[rel];
        if (stored === undefined) {
            return 'unchanged';
        }
        if (stored.chunkIds.length > 0) {
            await this.deleteChunks(stored.chunkIds, 'indexer delete-stale');
        }
        delete this.state.files[rel];
        this.saveState();
        return 'purged';
    }
    // Recursive walk of `<vault>/markdown/**/*.md`. Dotfiles, dot dirs, and
    // reserved non-indexed names (.INTENTS.md, DREAMS.md, *_history.md)
    // never enter the index.
    listMarkdownFiles() {
        const files = [];
        const walk = (dirAbsolute, relDir) => {
            const entries = this.fsLike.listDirectory(dirAbsolute);
            if (entries === null) {
                return;
            }
            for (const entry of entries) {
                if (entry.directory) {
                    if (!entry.name.startsWith('.')) {
                        walk(join(dirAbsolute, entry.name), `${relDir}/${entry.name}`);
                    }
                    continue;
                }
                if (!entry.name.endsWith('.md') || entry.name.startsWith('.')
                    || isReservedNonIndexed(entry.name)) {
                    continue;
                }
                files.push(`${relDir}/${entry.name}`);
            }
        };
        walk(markdownDir(this.vault.path), 'markdown');
        files.sort();
        if (files.length > MAX_FILES_PER_VAULT) {
            this.log(`${this.vault.path}: ${files.length} files exceeds cap ${MAX_FILES_PER_VAULT}; tail dropped`);
            return files.slice(0, MAX_FILES_PER_VAULT);
        }
        return files;
    }
    // A stored state built for a different model, width, or schema version
    // means every chunkId is (about to be) wrong: force full re-embed, and
    // the per-file stale-delete removes the old-model rows.
    stateNeedsFullRebuild(state) {
        return state.version !== INDEX_STATE_VERSION
            || state.modelId !== this.embedder.modelId
            || state.vectorDim !== this.embedder.dim;
    }
    readStateFromDisk() {
        const fresh = () => ({
            version: INDEX_STATE_VERSION,
            modelId: this.embedder.modelId,
            vectorDim: this.embedder.dim,
            files: {},
        });
        const raw = this.fsLike.readFile(this.stateFilePath);
        if (raw === null) {
            return fresh();
        }
        try {
            const parsed = JSON.parse(raw);
            const files = (parsed.files ?? {});
            return {
                version: typeof parsed.version === 'number' ? parsed.version : 0,
                modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
                vectorDim: typeof parsed.vectorDim === 'number' ? parsed.vectorDim : -1,
                files,
            };
        }
        catch (error) {
            this.log(`state file unreadable (${this.stateFilePath}): ${describeError(error)}; starting fresh`);
            return fresh();
        }
    }
    // Atomic state write: tmp file plus rename inside the metadata dir.
    // The model stamp (version/modelId/vectorDim) is NOT rewritten here:
    // it flips only after a full run finishes clean (end of reindex), so a
    // crash mid-migration leaves the old stamp and the next run re-forces
    // the full rebuild instead of stranding old-model rows.
    saveState() {
        const statePath = this.stateFilePath;
        this.fsLike.mkdirp(metadataDir(this.vault.path));
        const tmpPath = `${statePath}.tmp`;
        this.fsLike.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`);
        this.fsLike.rename(tmpPath, statePath);
    }
    // Watcher events only mark dirt; the debounce window collapses Obsidian's
    // save churn (write+rename emits several events per save).
    onWatchEvent(fileName) {
        if (this.stopped) {
            return;
        }
        if (fileName === null) {
            this.dirtyAll = true;
        }
        else {
            const rel = this.normalizeRel(`markdown/${fileName.replace(/\\/g, '/')}`);
            if (rel === null) {
                return;
            }
            this.dirty.add(rel);
        }
        this.scheduleFlush();
    }
    // Restart the debounce window: Obsidian's save churn (a write plus a
    // rename) fires several events per save, and the last one wins.
    scheduleFlush() {
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.flushDirty();
        }, WATCH_DEBOUNCE_MS);
        this.debounceTimer.unref?.();
    }
    flushDirty() {
        if (this.stopped) {
            return;
        }
        if (this.dirtyAll) {
            this.dirtyAll = false;
            this.dirty.clear();
            void this.reindex().catch((error) => {
                this.errors += 1;
                this.log(`watcher reindex failed: ${describeError(error)}`);
            });
            return;
        }
        const rels = [...this.dirty];
        this.dirty.clear();
        for (const rel of rels) {
            void this.indexFile(rel).catch((error) => {
                this.errors += 1;
                this.log(`watcher index of ${rel} failed: ${describeError(error)}`);
            });
        }
    }
    // Stat sweep (every pollIntervalMs): any mtime drift or file-count drift
    // re-dirties the vault. Content-hash diffs in processFile make a duplicate
    // sweep cost nothing but stats.
    pollStats() {
        if (this.stopped) {
            return;
        }
        const files = this.listMarkdownFiles();
        let drifted = files.length !== Object.keys(this.state.files).length;
        for (const rel of files) {
            const stored = this.state.files[rel];
            const mtime = this.fsLike.stat(join(this.vault.path, rel))?.mtimeMs;
            if (mtime === undefined || stored === undefined || mtime !== stored.mtimeMs) {
                drifted = true;
                break;
            }
        }
        if (drifted) {
            this.dirtyAll = true;
            // An open debounce window already covers this sweep; re-arming it on
            // every poll would postpone the flush forever in a busy vault.
            if (this.debounceTimer === null) {
                this.scheduleFlush();
            }
        }
    }
    // Accept vault-relative or vault-absolute paths; anything outside
    // <vault>/markdown or not a candidate .md file normalizes to null.
    normalizeRel(input) {
        let rel = input.replace(/\\/g, '/');
        if (rel.startsWith(`${this.vault.path.replace(/\\/g, '/')}/`)) {
            rel = rel.slice(this.vault.path.length + 1);
        }
        if (!rel.startsWith('markdown/') || !rel.endsWith('.md')) {
            return null;
        }
        const base = rel.slice(rel.lastIndexOf('/') + 1);
        if (base.startsWith('.') || isReservedNonIndexed(base)) {
            return null;
        }
        return rel;
    }
}
/**
 * IndexerManager runs one VaultIndexer per registered vault: start()
 * (background full-scan plus watchers), reindexAll() (card and audit
 * manual trigger), the write-through indexFile(vaultPath, rel) hook, and
 * summed progress. Lookup is by the exact vault path (registry paths are
 * already realpath-canonical).
 */
export class IndexerManager {
    indexers = new Map();
    constructor(options) {
        for (const vault of options.vaults) {
            this.indexers.set(vault.path, new VaultIndexer({ ...options, vault }));
        }
    }
    /** Start every vault indexer (full-scan background + watch). */
    start() {
        for (const indexer of this.indexers.values()) {
            indexer.start();
        }
    }
    /** Stop every watcher and timer. */
    stop() {
        for (const indexer of this.indexers.values()) {
            indexer.stop();
        }
    }
    /** ReindexAll re-diffs every vault sequentially (single writer). */
    async reindexAll() {
        for (const indexer of this.indexers.values()) {
            await indexer.reindex();
        }
    }
    /**
     * IndexFile is the write-through hook: vaultPath must be a registered
     * vault; returns false when it is not.
     */
    async indexFile(vaultPath, relPath) {
        const indexer = this.indexers.get(vaultPath);
        if (indexer === undefined) {
            return false;
        }
        await indexer.indexFile(relPath);
        return true;
    }
    /** Progress sums the per-vault counters. */
    progress() {
        const total = { indexed: 0, pending: 0, errors: 0, llmErrors: 0 };
        for (const indexer of this.indexers.values()) {
            const vaultProgress = indexer.progress;
            total.indexed += vaultProgress.indexed;
            total.pending += vaultProgress.pending;
            total.errors += vaultProgress.errors;
            total.llmErrors += vaultProgress.llmErrors;
        }
        return total;
    }
    /** VaultProgress reports one vault's counters; null when unmanaged. */
    vaultProgress(vaultPath) {
        return this.indexers.get(vaultPath)?.progress ?? null;
    }
}
//# sourceMappingURL=indexer.js.map
