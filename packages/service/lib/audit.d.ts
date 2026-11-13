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
import type { NoteMeta } from '../../core/lib/index.js';
import type { ResolvedObsidianMemConfig } from './config.js';
import type { IndexProgress } from './indexer.js';
import type { GlobalMemoryIndex, ObsidianMemStatus, VaultEntry } from './service.js';
/** ISSUE means fix something; INFO is report context. */
export type AuditSeverity = 'ISSUE' | 'INFO';
/** One audit finding. `remediation` is the fix instruction, never advice. */
export interface AuditIssue {
    id: string;
    severity: AuditSeverity;
    detail: string;
    remediation: string;
}
/** The bounded row list a `memory_audit` call shows. */
export declare const AUDIT_VIEWS: readonly ["full", "topStale", "oldestUnread"];
/** One of the {@link AUDIT_VIEWS} note-row orders. */
export type AuditView = typeof AUDIT_VIEWS[number];
/** Request knobs of one audit pass; rollups are unbounded, rows are not. */
export interface AuditRequest {
    view?: AuditView;
    limit?: number;
}
/** One note as the audit saw it (size-first; big notes stay unread). */
export interface AuditedNote {
    path: string;
    vaultPath: string;
    /** Vault-relative posix path, the indexer state key space. */
    rel: string;
    sizeBytes: number;
    mtimeMs: number;
    /** True past the read cap: size is known, frontmatter is not. */
    flaggedNotRead: boolean;
    /** Quoted parse error; null when the note parsed (or was not read). */
    malformed: string | null;
    meta: NoteMeta | null;
    /** Present in the vault indexer state file. */
    indexed: boolean;
}
/** One vault's stat facts. */
export interface VaultFsFacts {
    exists: boolean;
    markdownPresent: boolean;
    metadataPresent: boolean;
    writable: boolean;
}
/** What the audit could read of one vault's indexer state file. */
export interface VaultStateInfo {
    path: string;
    present: boolean;
    parseError: string | null;
    modelId: string | null;
    vectorDim: number | null;
    fileCount: number;
    expectedChunks: number;
    /** Vault-relative state keys; the `indexed` flag's lookup set. */
    fileKeys: string[];
}
/** One vault fully inventoried by {@link inventoryVault}. */
export interface VaultInventory {
    vault: VaultEntry;
    facts: VaultFsFacts;
    notes: AuditedNote[];
    /** Reserved protocol names found inside markdown/ (they belong at the root). */
    reservedMisplaced: string[];
    /** True when the stat walk hit its entry cap. */
    walkTruncated: boolean;
    /** Bytes under the vault root (excluding dot dirs, metadata/, and the model cache). */
    usageBytes: number;
    state: VaultStateInfo;
}
/** The live-collection answer the service's injected probe produces. */
export interface CollectionProbeResult {
    reachable: boolean;
    exists: boolean;
    /** Stored dense_vector width, null when unknown. */
    dim: number | null;
    /** Approximate entity count from collection statistics. */
    count: number | null;
    error: string | null;
}
/** The global-memory budget section (TASK-045 consumes what feeds this). */
export interface GlobalBudgetReport {
    budgetTokens: number;
    usedTokens: number;
    /** False when the tracker reported nothing measurable this process. */
    measured: boolean;
    overBudget: boolean;
    globalNoteCount: number;
    /** Absolute paths of live global notes, sorted least-read first. */
    globalNotePaths: string[];
}
/** A report row (a bounded, model-facing projection of an AuditedNote). */
export interface AuditNoteRow {
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    readCount: number;
    lastReadAt: string;
    archived: boolean;
    indexed: boolean;
    flaggedNotRead: boolean;
    oversized: boolean;
}
/** The complete structured answer of one audit pass. */
export interface AuditReport {
    ok: boolean;
    generatedAt: number;
    view: AuditView;
    limit: number;
    issues: AuditIssue[];
    stats: {
        vaultCount: number;
        sharedVaultCount: number;
        noteCount: number;
        archivedCount: number;
        totalBytes: number;
        vaultUsage: Array<{
            vault: string;
            notes: number;
            bytes: number;
        }>;
        oversizedNotes: string[];
        hugeNotReadNotes: string[];
        malformedNotes: string[];
        indexer: IndexProgress | null;
        collectionCount: number | null;
        expectedChunks: number | null;
        lastDreamAt: number | null;
        dreamingSchedules: number;
    };
    rows: AuditNoteRow[];
    totalRows: number;
    budget: GlobalBudgetReport;
}
/**
 * AuditFs is the strictly read-only fs seam the engine walks. There is no
 * write method to spy on: writing from the engine is unrepresentable, and
 * service-level tests additionally assert the service's own fs recorded no
 * mutation across an audit call.
 */
export interface AuditFs {
    exists(path: string): boolean;
    /** Null when the path does not exist. */
    stat(path: string): {
        sizeBytes: number;
        mtimeMs: number;
        directory: boolean;
        writable: boolean;
    } | null;
    /** UTF-8 contents, or null when missing/unreadable. */
    readFile(path: string): string | null;
    /** Directory entries; null when missing or unreadable. */
    listDirectory(path: string): Array<{
        name: string;
        directory: boolean;
    }> | null;
}
/** Node implementation of {@link AuditFs} over node:fs. */
export declare const nodeAuditFs: AuditFs;
/** Everything the engine reads of the live index; injected so status stays sync. */
export interface AuditDeps {
    vaults: VaultEntry[];
    status: ObsidianMemStatus;
    config: ResolvedObsidianMemConfig;
    globalIndex: GlobalMemoryIndex & {
        overBudget?: boolean;
    };
    /** Absolute home base (no os calls inside the engine). */
    homedir: string;
    fs: AuditFs;
    /** Live collection probe; null when the index is cold (never contacted). */
    collection: (() => Promise<CollectionProbeResult>) | null;
}
/**
 * InventoryVault walks one vault read-only: the root note tree (the vault
 * root IS the note root; size-before-read, read cap, reserved placement,
 * dot-dir skips), the whole-tree disk usage minus the model cache, and the
 * indexer state file. Shared by the audit report and the dream plan (single
 * source of truth).
 */
export declare function inventoryVault(vault: VaultEntry, fs: AuditFs): VaultInventory;
/** ReadLastDreamAt answers the dream stamp from the plugin state dir. */
export declare function readLastDreamAt(readSource: {
    readFile(path: string): string | null;
}, dbPath: string): number | null;
/**
 * GlobalNotePaths lists live global-scope notes sorted least-read first:
 * the order the over-budget compaction instruction names, and the dream
 * plan's budget input (shared with memory_dream, single source of truth).
 */
export declare function globalNotePaths(notes: readonly AuditedNote[]): string[];
/**
 * GlobalBudgetReport folds the tracker echo and the note inventory into the
 * shared budget section. Audit and the dream plan read the same numbers
 * from here (single source of truth for the compaction instruction).
 */
export declare function globalBudgetReport(notes: readonly AuditedNote[], globalIndex: GlobalMemoryIndex & {
    overBudget?: boolean;
}): GlobalBudgetReport;
/**
 * DayEnd answers the epoch of the end of the day (23:59:59.999Z) a
 * YYYY-MM-DD note stamp names, so a read on that day counts as access
 * through the whole day. Full ISO stamps parse as they are; an
 * unparseable stamp answers 0. Audit's staleness ranking and the dream
 * engine's unread-since-last-dream test share this rule (single source).
 */
export declare function dayEnd(stamp: string): number;
/**
 * RunStoreAudit runs the full doctor pass and assembles the structured
 * report. It never provisions and never writes; the collection probe (when
 * given) is one describe plus one statistics read.
 */
export declare function runStoreAudit(deps: AuditDeps, request?: AuditRequest): Promise<AuditReport>;
//# sourceMappingURL=audit.d.ts.map
