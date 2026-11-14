/**
 * `ctx.obsidianMem`: the vault registry, embedder, Milvus-Lite lifecycle,
 * indexer manager, and hybrid search behind the memory_* tools.
 *
 * Export shape (verified against the installed @deepseek-ai/cordis 4.1.0):
 * a `Service`-class default export. cordis's Fiber runs
 * `new callback(ctx, config)` for class plugins (fiber.ts execute), reads
 * the static `Config` (a Standard-Schema) through the `internal/config`
 * waterfall, and publishes the seam from the `super(ctx, 'obsidianMem')`
 * call in the constructor. That is the engramory-ext §2.2 shape, so no
 * `apply(ctx, config)` fallback is needed; the patch rows'
 * `inject: ['obsidianMem']` resolve against this name.
 *
 * Activation discipline (Decision log "Lazy default vault"): construction
 * and `[Service.init]` touch no disk and spawn nothing. Everything below
 * `ensureMemoryAccess()` provisions once: the default vault and its
 * .INTENTS.md when no shared vault is configured, the Milvus dbDir, the
 * background uvx cache pre-warm (spawn mode), the launcher with the G13
 * generous readiness timeout, the long-lived client only after readiness
 * (G12), the collection (dim drift → rebuild → forced full reindex), and
 * the indexer background start. A failed Milvus start degrades to status
 * reports and typed IndexOfflineError from search, never a crash.
 * @module dsh-plugin-obsidian-mem/service
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { NoteMeta, VaultConfig, VaultMode } from '../../core/lib/index.js';
import type { CardEditableConfig, CardEditablePartial, ObsidianMemConfig, ResolvedObsidianMemConfig } from './config.js';
import type { AuditFs, AuditReport, AuditRequest } from './audit.js';
import type { DreamEngineResult, DreamRequest, DreamRunSummary } from './dream.js';
import type { Embedder } from './embedder.js';
import { IndexerManager } from './indexer.js';
import type { IndexProgress } from './indexer.js';
import type { MilvusLauncherOptions, MilvusStartResult } from './milvus/launcher.js';
import type { ExactSectionRequest, MemorySearchResult, SearchRequest } from './search.js';
/** Seam name this service publishes; the patch rows inject this name. */
export declare const OBSIDIAN_MEM_SEAM = "obsidianMem";
/** File holding the card-managed vault additions under the state dir. */
export declare const VAULTS_FILE_NAME = "vaults.json";
/** File holding card settings overrides, anchored at the fixed core state dir. */
export declare const SETTINGS_FILE_NAME = "settings.json";
/** Who registered a vault: the row config, the settings card, or lazy provisioning. */
export type VaultSource = 'settings' | 'card' | 'default';
/** A registered vault plus who registered it (the card's remove affordance). */
export interface VaultEntry extends VaultConfig {
    source: VaultSource;
}
/** One read-registry record: what the plugin last saw at this path. */
export interface ReadRegistryEntry {
    contentHash: string;
    mtimeMs: number;
    /** Epoch ms of the recorded read; TASK-033 staleness input. */
    at: number;
}
/** Result of {@link ObsidianMemService.read}. */
export interface ObsidianMemReadResult {
    path: string;
    meta: NoteMeta;
    /** Body sliced by the 1-based offset/limit window. */
    body: string;
    mode: VaultMode;
    /** False when a read-only vault made the read skip the stats write. */
    statsUpdated: boolean;
    offset: number;
    limit: number;
    totalLines: number;
    truncated: boolean;
}
/** Input for {@link ObsidianMemService.write}/{@link ObsidianMemService.applyWrite}. */
export interface ObsidianMemWriteRequest {
    path: string;
    meta: NoteMeta;
    body: string;
}
/** Result of {@link ObsidianMemService.applyWrite}. */
export interface ObsidianMemWriteResult {
    path: string;
    created: boolean;
    vaultPath: string;
    /** Path relative to the vault root, e.g. `topic.md`. */
    relPath: string;
}
/** The global recall-budget view (TASK-045): configured budget vs injected usage. */
export interface GlobalMemoryIndex {
    budgetTokens: number;
    /** Recall tokens injected across every session the wired registry knows. */
    usedTokens: number;
    remainingTokens: number;
    /** True when usedTokens exceeds budgetTokens (strictly over). */
    overBudget: boolean;
}
/**
 * One shared vault's global memory file for TASK-014's pinned session-start
 * injection: the containing vault, the absolute resolved file path, and the
 * raw text as stored (no parsing, no offset windowing).
 */
export interface GlobalMemorySource {
    /** Absolute path of the shared vault that owns the file. */
    vaultPath: string;
    /** Absolute `<vault path>/<globalFile>` the content was read from. */
    path: string;
    /** Raw UTF-8 file text, verbatim. */
    content: string;
}
/**
 * SessionRegistryView is the minimal slice the service needs of the
 * per-session memory registry (TASK-040 seam). The events package owns and
 * constructs the registry instance; the service only holds the wired
 * reference, so the package dependency stays events → service, never back.
 * TASK-045 reads recall usage through it inside globalMemoryIndex; a
 * successful dream zeroes it through resetRecallUsage (TASK-002), so the
 * summed number means "tokens injected since the last successful dream or
 * host restart".
 */
export interface SessionRegistryView {
    /** Sums the recall tokens injected across every session the registry knows. */
    totalRecallTokensUsed(): number;
    /** Zeroes every live session's recall counter; wired to the dream ok path. */
    resetRecallUsage(): void;
    /**
     * Rebases the per-turn Think cap to a newly applied
     * budgets.thinkShotsPerTurn (TASK-004 live apply). OPTIONAL: the live
     * SessionRegistry grew this method after the view existed, so the service
     * calls it through optional chaining and an older wired registry simply
     * keeps its boot-baked cap until a restart.
     */
    setThinkShotsPerTurn?(shots: number): void;
}
/** The seam's status answer; sync so the card can poll without provisioning. */
export interface ObsidianMemStatus {
    state: 'inactive' | 'provisioning' | 'ready' | 'degraded';
    /** The default-vault notice text while a provisioned default vault is in use. */
    notice: string | null;
    defaultVaultPath: string | null;
    vaults: VaultEntry[];
    vectorDim: number;
    model: {
        id: string;
        dtype: string;
    };
    milvus: {
        mode: 'spawn' | 'external';
        address: string | null;
        dbPath: string;
        version: string | null;
        degraded: boolean;
        error: string | null;
        readinessTimeoutMs: number;
    };
    indexer: IndexProgress | null;
    budgets: ResolvedObsidianMemConfig['budgets'];
    dreaming: ResolvedObsidianMemConfig['dreaming'];
    /** DreamOrchestrator runtime view for the card Dreaming section. */
    dream: ObsidianMemDreamStatus;
}
/** ObsidianMemDreamStatus is the card-facing orchestrator state. */
export interface ObsidianMemDreamStatus {
    /** The single-flight guard: one run at a time, host-wide. */
    state: 'idle' | 'running';
    /** Why runs cannot start at all (no agents gateway); null when ready. */
    blocked: string | null;
    lastDreamAt: number | null;
    lastRun: DreamRunSummary | null;
}
/** Add-request for {@link ObsidianMemService.addVault}. */
export interface VaultAddRequest {
    path: string;
    mode?: string;
    /** Vault-root-relative global memory file; blank or omitted takes the layout default. */
    globalFile?: string;
}
/**
 * CardSettingsView is the Configuration pane's whole answer from
 * {@link ObsidianMemService.cardSettings}.
 */
export interface CardSettingsView {
    /** The persisted effective values the card edits and displays (paths home-expanded). */
    settings: CardEditableConfig;
    /** Exactly the whitelisted keys the card has set (the "custom" badges and per-key reset source). */
    overrides: CardEditablePartial;
    /** Whitelisted dot-paths whose persisted value differs from the in-process config (the "restart to apply" chips). */
    restartPending: string[];
}
/** Patch accepted by {@link ObsidianMemService.updateCardSettings}. */
export interface CardSettingsPatch {
    /** Whitelisted leaves to store; values failing the config schema reject the whole patch. */
    set: CardEditablePartial;
    /** Whitelisted dot-paths to drop from the stored overrides, falling back to the profile row. */
    unset?: string[];
}
/**
 * ServiceFs is the seam the service itself touches disk through; tests
 * pass an in-memory tree, production gets the node:fs object below.
 */
export interface ServiceFs {
    exists(path: string): boolean;
    realpath(path: string): string;
    mkdirp(path: string): void;
    readFile(path: string): string | null;
    writeFile(path: string, contents: string): void;
    rename(from: string, to: string): void;
    unlink(path: string): void;
    stat(path: string): {
        mtimeMs: number;
    } | null;
}
/** Node implementation of ServiceFs over node:fs. */
export declare const nodeServiceFs: ServiceFs;
/** Launcher slice the service drives; MilvusLauncher satisfies it. */
export interface MilvusLauncherLike {
    start(): Promise<MilvusStartResult>;
    dispose(): Promise<void>;
    readonly degraded: boolean;
    readonly address: string | null;
}
/** IndexerManager slice the service drives. */
export interface IndexerLike {
    start(): void;
    stop(): void;
    reindexAll(): Promise<void>;
    indexFile(vaultPath: string, relPath: string): Promise<boolean>;
    progress(): IndexProgress;
}
/** The test seams; production mounts without any of them. */
export interface ObsidianMemHooks {
    /** Home base for vault/db/state defaults; default os.homedir. */
    homedir?: () => string;
    /** Disk seam for everything the service itself reads/writes. */
    fs?: ServiceFs;
    /** Builds the launcher; default (options) => new MilvusLauncher(options). */
    launcherFactory?: (options: MilvusLauncherOptions) => MilvusLauncherLike;
    /** Long-lived client factory (G12: called only after readiness). */
    clientFactory?: (address: string) => Promise<MilvusClient>;
    /** Embedder seam; default createEmbedder from the resolved config. */
    embedder?: Embedder;
    /** Builds the per-vault indexer manager; default IndexerManager. */
    indexerFactory?: (options: ConstructorParameters<typeof IndexerManager>[0]) => IndexerLike;
    /** uvx cache warm for spawn mode; default a detached `uvx ... --help`. */
    prewarm?: (command: string, args: readonly string[]) => void;
    /** Read-only fs the audit engine walks; default nodeAuditFs. */
    auditFs?: AuditFs;
}
/**
 * ObsidianMemService is `ctx.obsidianMem`. Construction resolves config
 * (schema defaults applied, persisted card overrides merged over the row,
 * `~` expanded) and writes or spawns nothing; `ensureMemoryAccess()` runs
 * the one-time provisioning pass; every memory-facing method (read, write,
 * search, addVault persistence) routes through it or owns its explicit disk
 * effect.
 */
export declare class ObsidianMemService extends Service {
    /** The plugin config schema every mounted row validates against. */
    static Config: NonNullable<Plugin.Base<ResolvedObsidianMemConfig>['Config']>;
    /** The resolved config: schema defaults plus home-expanded paths. */
    readonly config: ResolvedObsidianMemConfig;
    private readonly rowConfig;
    private readonly fs;
    private readonly homedir;
    private readonly launcherFactory;
    private readonly clientFactory;
    private readonly indexerFactory;
    private readonly prewarm;
    private readonly auditFs;
    private dreamEngineValue;
    private readonly log;
    private registry;
    private sessionRegistryValue;
    private readonly readRegistry;
    private access;
    private phase;
    private noticeText;
    private defaultVault;
    private launcher;
    private client;
    private milvusVersion;
    private milvusError;
    private embedderStore;
    private readonly embedderSeamProvided;
    private indexer;
    private teardownRegistered;
    private teardownPromise;
    private cardSettingsApplying;
    /**
     * @param ctx - the cordis context the seam mounts into.
     * @param config - the mounted row config; every field defaults, `{}` is complete.
     * @param hooks - the test seams; production passes none.
     */
    constructor(ctx: Context, config?: ObsidianMemConfig, hooks?: ObsidianMemHooks);
    /**
     * Cordis runs this after construction; the seam intentionally activates
     * inertly (Decision log: activation must stay side-effect free), so
     * provisioning lives behind ensureMemoryAccess, not here.
     */
    [Service.init](): void;
    /**
     * EnsureMemoryAccess is the idempotent lazy-provisioning seam. The first
     * caller runs the provisioning pass and receives the one-time default-
     * vault notice (when a default was provisioned); later and concurrent
     * callers await the same pass and get `undefined`. A failed pass clears
     * the flight so the next call may retry.
     */
    ensureMemoryAccess(): Promise<string | undefined>;
    /** ListVaults returns the live registry; it never provisions. */
    listVaults(): VaultEntry[];
    /**
     * GlobalMemorySources answers every shared vault's global memory file
     * (TASK-014): `<vault path>/<globalFile>` read as raw text, in registry
     * order. Read-only vaults are excluded. A missing or unreadable file is
     * skipped with a debug log, never a throw, and nothing is provisioned.
     * The read bypasses the read registry and never bumps note read stats;
     * the joined path is refused when it lands outside the vault, a belt over
     * the config/addVault shape validation that already refuses absolute and
     * `..` forms (core globalFilePath, shared with the TASK-015 dream
     * protection).
     */
    globalMemorySources(): GlobalMemorySource[];
    /**
     * AddVault registers a card-side vault: `shared` paths are created
     * (root + `.obsidian-mem/metadata/`), `read-only` paths must already
     * exist, duplicates are refused with the current registration named, and
     * settings-managed paths cannot be shadowed. `globalFile` is resolved
     * through core resolveGlobalFile (blank or omitted → the layout default)
     * and refused when it is absolute or climbs with `..`. New card vaults
     * persist to <stateDir>/vaults.json atomically.
     */
    addVault(request: VaultAddRequest): VaultEntry;
    /**
     * CommitRegistryMutation is the ONE card-registry mutation seam: apply
     * the change to the live registry, rewrite vaults.json, and re-form the
     * indexer, so add and remove cannot fork the persist/restart pair. The
     * provision-time default-vault push is the deliberate exception: it is
     * never persisted, and provisioning owns its own indexer start.
     */
    private commitRegistryMutation;
    /**
     * RemoveVault drops a card-added vault: its chunks are deleted from the
     * collection by the vault filter (when the index is live), its
     * read-registry entries and vaults.json record go, and the indexer
     * re-forms without it. Settings-configured and auto-provisioned default
     * vaults refuse with the actionable place to remove them.
     */
    removeVault(path: string): Promise<void>;
    /**
     * Read returns a note's meta plus a 1-based line slice of its body, and
     * updates the frontmatter read stats (read_count +1, last_read_at=today)
     * for shared vaults via the raw-preserving serializer; read-only vaults
     * skip the stats write and answer statsUpdated: false. Every read
     * records {contentHash, mtimeMs, at} in the read registry for the
     * memory_write staleness guard (TASK-033).
     */
    read(absPath: string, options?: {
        offset?: number;
        limit?: number;
    }): Promise<ObsidianMemReadResult>;
    /**
     * Write orchestrates a note write end to end: meta validation (core
     * validateMeta errors throw), then applyWrite. The path-scoping,
     * staleness, and read-only guard conversation live in the memory_write
     * tool (TASK-033); this stays the single write-through primitive chain.
     */
    write(request: ObsidianMemWriteRequest): Promise<ObsidianMemWriteResult>;
    /**
     * ApplyWrite merges the parsed frontmatter of an existing file back in
     * before serializing (TASK-025 carry-over #1: serializeNote renders the
     * modelled keys only, so keywords/trigger_extensions and every other
     * un-modelled author key would otherwise be silently dropped on
     * rewrite), writes atomically, updates the read registry, and hands the
     * path to the indexer's write-through queue. Read-only vaults refuse.
     */
    applyWrite(path: string, meta: NoteMeta, body: string): Promise<ObsidianMemWriteResult>;
    /**
     * Search routes through ensureMemoryAccess and the shared hybridSearch
     * pipeline; an offline or crashed index answers with the typed
     * IndexOfflineError callers degrade quietly on, never a hang or crash.
     */
    search(request: SearchRequest): Promise<MemorySearchResult[]>;
    /**
     * SearchExactSections routes the Read intercept (TASK-042) through
     * ensureMemoryAccess and the shared exact-section pipeline, with the same
     * offline discipline as `search` (typed IndexOfflineError, never a hang).
     */
    searchExactSections(request: ExactSectionRequest): Promise<MemorySearchResult[]>;
    private searchClient;
    /** Status answers the card and audit without triggering provisioning. */
    status(): ObsidianMemStatus;
    private dreamStatus;
    /**
     * CardSettings answers the Configuration pane without ever provisioning:
     * `settings` are the persisted effective values (the profile row merged
     * with settings.json and home-expanded, so a pending milvus.dbPath
     * displays the path the next host start will use), `overrides` are
     * exactly the whitelisted keys the card has set, and `restartPending`
     * names the whitelisted dot-paths whose persisted value the running
     * config has not caught up with. A hand-edited stored value that fails
     * schema validation is kept out of the view (the running values stand
     * in), mirroring the boot fallback.
     */
    cardSettings(): CardSettingsView;
    /**
     * UpdateCardSettings applies a whitelisted settings patch. `set` paths
     * outside CARD_SETTINGS_KEYS, `unset` paths that are not whitelisted
     * leaves, values failing the full config schema (deep-merged into a draft
     * of the effective config), and a call racing an apply still in flight
     * (one apply runs at a time) all REJECT with the joined messages for the
     * route to map to 400; nothing persists on a rejected patch. The merged
     * overrides record is written atomically, a persisted milvus.dbPath move
     * carries the current vaults.json into the new state dir best-effort, and
     * the live-apply escalation (TASK-004) swaps the running config and
     * re-forms the subsystems with the smallest safe escalation. The promise
     * answers the fresh view; an escalation failure rejects with the previous
     * config values left applied, so the persisted delta reports itself as
     * restartPending. It never provisions.
     */
    updateCardSettings(patch: CardSettingsPatch): Promise<CardSettingsView>;
    /**
     * ResetCardSettings ("Reset all to profile settings") clears every
     * stored override: the file keeps its version stamp with an empty
     * overrides object, a dbPath the overrides had moved goes back to the
     * row's state dir via the vaults.json carry, the escalation re-applies
     * toward the row values, and the fresh view answers. Same rejection
     * behavior as {@link ObsidianMemService.updateCardSettings}.
     */
    resetCardSettings(): Promise<CardSettingsView>;
    /**
     * GlobalMemoryIndex is the global recall-budget view (TASK-045): the
     * configured budget against the recall tokens the wired
     * {@link ObsidianMemService.sessionRegistry} sums across every session it
     * knows. Before the events row wires a registry the view reports zero
     * use (nothing has been injected since the last successful dream or
     * host restart).
     */
    globalMemoryIndex(): GlobalMemoryIndex;
    /**
     * SetSessionRegistry wires the events-owned SessionRegistry (TASK-040
     * seam change): the events package constructs and owns the registry, the
     * service just holds the reference so TASK-045's global budget accounting
     * can read session usage without importing events. Passing null unwires
     * (the events row unloading).
     */
    setSessionRegistry(registry: SessionRegistryView | null): void;
    /** SessionRegistry is the events-wired registry, or null before it mounts. */
    get sessionRegistry(): SessionRegistryView | null;
    /**
     * Audit drives the read-only doctor pass (TASK-034). It never provisions
     * and never writes: the registry comes from the sync read path, the
     * filesystem walk goes through the read-only AuditFs seam, and a live
     * collection is contacted only through one probe (describe + statistics)
     * when the index already reports ready.
     */
    audit(request?: AuditRequest): Promise<AuditReport>;
    private probeCollection;
    /**
     * Dream drives the compaction orchestrator (TASK-035). `plan` answers the
     * deterministic analysis; `run` arms the single-flight guard, launches a
     * dedicated dream agent through the reflection gateway `ctx.get('agents')`
     * (never a typed agents import), and answers {id, done} immediately: the
     * CALLER attaches a swallowing logging catch to done and never awaits it
     * inline. Busy and blocked arrive as DreamBusyError / DreamBlockedError;
     * the tool maps them to their kind values.
     */
    dream(request?: DreamRequest): Promise<DreamEngineResult>;
    private dreamEngine;
    private fetchNoteVectors;
    /**
     * ReadRecord answers the write-staleness guard (TASK-033): what the
     * plugin last saw at this path through read/applyWrite, or undefined
     * when the plugin never touched it.
     */
    readRecord(absPath: string): ReadRegistryEntry | undefined;
    /** Stop tears effects down once: indexers stop, the child dies, the client closes. */
    stop(): Promise<void>;
    private provision;
    private loadRegistry;
    private readVaultsFile;
    private persistVaultsFile;
    /**
     * ApplySettingsOverrides merges the whitelisted card overrides from
     * settings.json over the validated row config, card winning per leaf key
     * (the card edit is the newer user intent). A merged value that fails
     * schema re-validation (hand-edited junk) falls back to the row-only
     * config with a warn: a bad settings file costs its own edits, never the
     * boot. Runs before resolveServiceConfig.
     */
    private applySettingsOverrides;
    private readSettingsOverrides;
    private commitCardSettings;
    private applyCardSettings;
    private effectiveCardSettings;
    private persistSettingsOverrides;
    private copyVaultsFileToStateDir;
    private escalateCardSettings;
    private writeAtomic;
    private stateDirPath;
    private vaultsFilePath;
    private settingsFilePath;
    private vaultFs;
    private canonicalize;
    private duplicateVaultMessage;
    private getEmbedder;
    private buildIndexer;
    private restartIndexer;
    private dropVaultStateFiles;
    private dropVaultChunks;
    private modeForVaultValue;
    private registerTeardown;
    private teardown;
}
/**
 * WithObsidianMemHooks returns a mountable row class whose constructor
 * pre-binds {@link ObsidianMemHooks} to the seam parameter. cordis only ever
 * calls `new callback(ctx, config)` (Fiber._runner.execute), so a hooks-aware
 * mount needs the seam bound at the constructor; this is that binding, not a
 * second construction path. The returned class inherits the static Config and
 * inject entries and publishes the same `obsidianMem` seam, so `ctx.plugin()`
 * activation behaves exactly as with the bare class. Tests and non-default
 * hosts (an embedder redirecting home/state/db defaults into a scratch dir)
 * are the intended users; production bundle rows mount the class itself.
 *
 * @param hooks - the seams to bind; each keeps its own default when omitted.
 */
export declare function withObsidianMemHooks(hooks: ObsidianMemHooks): typeof ObsidianMemService;
//# sourceMappingURL=service.d.ts.map
