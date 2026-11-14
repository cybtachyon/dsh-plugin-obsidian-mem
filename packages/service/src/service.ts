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

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { MilvusClient } from '@zilliz/milvus2-sdk-node'

import {
  classifyPath,
  contentHash,
  dbStateDir,
  firstSharedVault,
  formatLocalDate,
  globalFilePath,
  isOverGlobalBudget,
  isReservedNonIndexed,
  isVaultMode,
  metadataDir,
  MILVUS_COLLECTION,
  MILVUS_FIELDS,
  modelCacheDir,
  parseNote,
  provisionDefaultVault,
  resolveGlobalFile,
  resolveVaults,
  seedIntentsFile,
  serializeNoteWithRaw,
  stateDir,
  validateMeta,
  VAULT_MODE_SHARED,
  VAULT_MODES,
} from '../../core/lib/index.js'
import type {
  FsProbe,
  NoteMeta,
  VaultConfig,
  VaultFs,
  VaultMode,
} from '../../core/lib/index.js'
import {
  CARD_SETTINGS_KEYS,
  expandHomePath,
  globalFileShapeIssue,
  isRecord,
  ObsidianMemConfigSchema,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
  vaultKey,
} from './config.js'
import type {
  CardEditableConfig,
  CardEditablePartial,
  ObsidianMemConfig,
  ResolvedObsidianMemConfig,
} from './config.js'
import {
  cardEditableSlice,
  differingCardSettingsPaths,
  filterCardSettingsTree,
  mergeCardSettingsPatch,
  removeCardSettingsPath,
  validateMergedCardSettings,
} from './card-settings.js'
import { inventoryVault, nodeAuditFs, runStoreAudit } from './audit.js'
import type { AuditFs, AuditReport, AuditRequest, CollectionProbeResult, VaultInventory } from './audit.js'
import { DreamOrchestrator } from './dream.js'
import type { DreamAgentsGateway, DreamDefaultModelGateway, DreamEngineResult, DreamRequest, DreamRunSummary, DreamVectorTarget } from './dream.js'
import { createEmbedder } from './embedder.js'
import type { Embedder } from './embedder.js'
import { describeError } from './errors.js'
import { indexStatePath, IndexerManager, STATE_FILE_TMP_SUFFIX } from './indexer.js'
import type { IndexProgress, IndexWriter } from './indexer.js'
import { readyMilvusClient } from './milvus/client.js'
import { MILVUS_LITE_VERSION, MilvusLauncher } from './milvus/launcher.js'
import type { MilvusLauncherOptions, MilvusStartResult } from './milvus/launcher.js'
import { assertOk } from './milvus/ok.js'
import { ensureCollection, rebuildCollection, storedDenseDim } from './milvus/schema.js'
import { hybridSearch, IndexOfflineError, searchExactSections } from './search.js'
import type {
  ExactSectionRequest,
  MemorySearchResult,
  SearchDependencies,
  SearchRequest,
} from './search.js'

/** Seam name this service publishes; the patch rows inject this name. */
export const OBSIDIAN_MEM_SEAM = 'obsidianMem'

/** File holding the card-managed vault additions under the state dir. */
export const VAULTS_FILE_NAME = 'vaults.json'

/** Schema version stamped on vaults.json; loading tolerates older files by key defaults. */
const VAULTS_FILE_VERSION = 1

/** File holding card settings overrides, anchored at the fixed core state dir. */
export const SETTINGS_FILE_NAME = 'settings.json'

/** Schema version stamped on settings.json; a newer file is ignored, never misread. */
const SETTINGS_FILE_VERSION = 1

/** Card settings whose apply re-forms the embedder and the indexer (TASK-004 escalation class). */
const EMBEDDER_CARD_SETTINGS_KEYS: readonly string[] = ['vectorDim', 'model.id', 'model.cacheDir']

/** Who registered a vault: the row config, the settings card, or lazy provisioning. */
export type VaultSource = 'settings' | 'card' | 'default'

/** A registered vault plus who registered it (the card's remove affordance). */
export interface VaultEntry extends VaultConfig {
  source: VaultSource
}

/** One read-registry record: what the plugin last saw at this path. */
export interface ReadRegistryEntry {
  contentHash: string
  mtimeMs: number
  /** Epoch ms of the recorded read; TASK-033 staleness input. */
  at: number
}

/** Result of {@link ObsidianMemService.read}. */
export interface ObsidianMemReadResult {
  path: string
  meta: NoteMeta
  /** Body sliced by the 1-based offset/limit window. */
  body: string
  mode: VaultMode
  /** False when a read-only vault made the read skip the stats write. */
  statsUpdated: boolean
  offset: number
  limit: number
  totalLines: number
  truncated: boolean
}

/** Input for {@link ObsidianMemService.write}/{@link ObsidianMemService.applyWrite}. */
export interface ObsidianMemWriteRequest {
  path: string
  meta: NoteMeta
  body: string
}

/** Result of {@link ObsidianMemService.applyWrite}. */
export interface ObsidianMemWriteResult {
  path: string
  created: boolean
  vaultPath: string
  /** Path relative to the vault root, e.g. `topic.md`. */
  relPath: string
}

/** The global recall-budget view (TASK-045): configured budget vs injected usage. */
export interface GlobalMemoryIndex {
  budgetTokens: number
  /** Recall tokens injected across every session the wired registry knows. */
  usedTokens: number
  remainingTokens: number
  /** True when usedTokens exceeds budgetTokens (strictly over). */
  overBudget: boolean
}

/**
 * One shared vault's global memory file for TASK-014's pinned session-start
 * injection: the containing vault, the absolute resolved file path, and the
 * raw text as stored (no parsing, no offset windowing).
 */
export interface GlobalMemorySource {
  /** Absolute path of the shared vault that owns the file. */
  vaultPath: string
  /** Absolute `<vault path>/<globalFile>` the content was read from. */
  path: string
  /** Raw UTF-8 file text, verbatim. */
  content: string
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
  totalRecallTokensUsed(): number
  /** Zeroes every live session's recall counter; wired to the dream ok path. */
  resetRecallUsage(): void
  /**
   * Rebases the per-turn Think cap to a newly applied
   * budgets.thinkShotsPerTurn (TASK-004 live apply). OPTIONAL: the live
   * SessionRegistry grew this method after the view existed, so the service
   * calls it through optional chaining and an older wired registry simply
   * keeps its boot-baked cap until a restart.
   */
  setThinkShotsPerTurn?(shots: number): void
}

/** The seam's status answer; sync so the card can poll without provisioning. */
export interface ObsidianMemStatus {
  state: 'inactive' | 'provisioning' | 'ready' | 'degraded'
  /** The default-vault notice text while a provisioned default vault is in use. */
  notice: string | null
  defaultVaultPath: string | null
  vaults: VaultEntry[]
  vectorDim: number
  model: { id: string; dtype: string }
  milvus: {
    mode: 'spawn' | 'external'
    address: string | null
    dbPath: string
    version: string | null
    degraded: boolean
    error: string | null
    readinessTimeoutMs: number
  }
  indexer: IndexProgress | null
  budgets: ResolvedObsidianMemConfig['budgets']
  dreaming: ResolvedObsidianMemConfig['dreaming']
  /** DreamOrchestrator runtime view for the card Dreaming section. */
  dream: ObsidianMemDreamStatus
}

/** Upper bound on stored chunk vectors pulled per candidate note. */
const DREAM_VECTOR_QUERY_LIMIT = 16

/** ObsidianMemDreamStatus is the card-facing orchestrator state. */
export interface ObsidianMemDreamStatus {
  /** The single-flight guard: one run at a time, host-wide. */
  state: 'idle' | 'running'
  /** Why runs cannot start at all (no agents gateway); null when ready. */
  blocked: string | null
  lastDreamAt: number | null
  lastRun: DreamRunSummary | null
}

/** Add-request for {@link ObsidianMemService.addVault}. */
export interface VaultAddRequest {
  path: string
  mode?: string
  /** Vault-root-relative global memory file; blank or omitted takes the layout default. */
  globalFile?: string
}

/**
 * CardSettingsView is the Configuration pane's whole answer from
 * {@link ObsidianMemService.cardSettings}.
 */
export interface CardSettingsView {
  /** The persisted effective values the card edits and displays (paths home-expanded). */
  settings: CardEditableConfig
  /** Exactly the whitelisted keys the card has set (the "custom" badges and per-key reset source). */
  overrides: CardEditablePartial
  /** Whitelisted dot-paths whose persisted value differs from the in-process config (the "restart to apply" chips). */
  restartPending: string[]
}

/** Patch accepted by {@link ObsidianMemService.updateCardSettings}. */
export interface CardSettingsPatch {
  /** Whitelisted leaves to store; values failing the config schema reject the whole patch. */
  set: CardEditablePartial
  /** Whitelisted dot-paths to drop from the stored overrides, falling back to the profile row. */
  unset?: string[]
}

/**
 * ServiceFs is the seam the service itself touches disk through; tests
 * pass an in-memory tree, production gets the node:fs object below.
 */
export interface ServiceFs {
  exists(path: string): boolean
  realpath(path: string): string
  mkdirp(path: string): void
  readFile(path: string): string | null
  writeFile(path: string, contents: string): void
  rename(from: string, to: string): void
  unlink(path: string): void
  stat(path: string): { mtimeMs: number } | null
}

/** Node implementation of ServiceFs over node:fs. */
export const nodeServiceFs: ServiceFs = {
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  mkdirp: (path) => { mkdirSync(path, { recursive: true }) },
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  writeFile: (path, contents) => { writeFileSync(path, contents, 'utf8') },
  rename: (from, to) => { renameSync(from, to) },
  unlink: (path) => { unlinkSync(path) },
  stat: (path) => {
    try {
      return { mtimeMs: statSync(path).mtimeMs }
    } catch {
      return null
    }
  },
}

/** Launcher slice the service drives; MilvusLauncher satisfies it. */
export interface MilvusLauncherLike {
  start(): Promise<MilvusStartResult>
  dispose(): Promise<void>
  readonly degraded: boolean
  readonly address: string | null
}

/** IndexerManager slice the service drives. */
export interface IndexerLike {
  start(): void
  stop(): void
  reindexAll(): Promise<void>
  indexFile(vaultPath: string, relPath: string): Promise<boolean>
  progress(): IndexProgress
}

/** The test seams; production mounts without any of them. */
export interface ObsidianMemHooks {
  /** Home base for vault/db/state defaults; default os.homedir. */
  homedir?: () => string
  /** Disk seam for everything the service itself reads/writes. */
  fs?: ServiceFs
  /** Builds the launcher; default (options) => new MilvusLauncher(options). */
  launcherFactory?: (options: MilvusLauncherOptions) => MilvusLauncherLike
  /** Long-lived client factory (G12: called only after readiness). */
  clientFactory?: (address: string) => Promise<MilvusClient>
  /** Embedder seam; default createEmbedder from the resolved config. */
  embedder?: Embedder
  /** Builds the per-vault indexer manager; default IndexerManager. */
  indexerFactory?: (options: ConstructorParameters<typeof IndexerManager>[0]) => IndexerLike
  /** uvx cache warm for spawn mode; default a detached `uvx ... --help`. */
  prewarm?: (command: string, args: readonly string[]) => void
  /** Read-only fs the audit engine walks; default nodeAuditFs. */
  auditFs?: AuditFs
}

/** The persisted card-vaults file shape. */
interface VaultFileRecord {
  version: number
  vaults: VaultFileEntry[]
}

/**
 * One persisted card vault. globalFile is optional in the record: files
 * written before TASK-004 lack the key, and load defaults it through core
 * resolveGlobalFile (inside resolveVaults), so old files keep working.
 */
interface VaultFileEntry {
  path: string
  mode: string
  globalFile?: string
}

/**
 * The persisted settings file shape: a partial config carrying only
 * CARD_SETTINGS_KEYS leaves (nested under their group keys, e.g.
 * `{ budgets: { searchTopK: 9 } }`). A key removed from the map means
 * "fall back to the profile row", never "set the default sentinel".
 */
interface SettingsFileRecord {
  version: number
  overrides: Record<string, unknown>
}

// One registry generation: resolved vaults plus who registered each path.
interface VaultRegistryView {
  vaults: VaultEntry[]
}

/**
 * ObsidianMemService is `ctx.obsidianMem`. Construction resolves config
 * (schema defaults applied, persisted card overrides merged over the row,
 * `~` expanded) and writes or spawns nothing; `ensureMemoryAccess()` runs
 * the one-time provisioning pass; every memory-facing method (read, write,
 * search, addVault persistence) routes through it or owns its explicit disk
 * effect.
 */
export class ObsidianMemService extends Service {
  /** The plugin config schema every mounted row validates against. */
  static Config: NonNullable<Plugin.Base<ResolvedObsidianMemConfig>['Config']> = ObsidianMemConfigSchema

  /** The resolved config: schema defaults plus home-expanded paths. */
  readonly config: ResolvedObsidianMemConfig

  // The profile-row config resolved WITHOUT card overrides. The persisted
  // card view is row + settings.json computed from this base (an `unset`
  // then genuinely returns a row value, which this.config may have
  // overwritten at boot); the live-apply escalation never mutates it.
  private readonly rowConfig: ResolvedObsidianMemConfig

  private readonly fs: ServiceFs
  private readonly homedir: () => string
  private readonly launcherFactory: (options: MilvusLauncherOptions) => MilvusLauncherLike
  private readonly clientFactory: (address: string) => Promise<MilvusClient>
  private readonly indexerFactory: ((options: ConstructorParameters<typeof IndexerManager>[0]) => IndexerLike) | null
  private readonly prewarm: (command: string, args: readonly string[]) => void
  private readonly auditFs: AuditFs
  private dreamEngineValue: DreamOrchestrator | null = null
  private readonly log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    debug(message: string): void
  }

  private registry: VaultRegistryView | null = null
  private sessionRegistryValue: SessionRegistryView | null = null
  private readonly readRegistry = new Map<string, ReadRegistryEntry>()
  private access: { promise: Promise<string | undefined> } | null = null
  private phase: ObsidianMemStatus['state'] = 'inactive'
  private noticeText: string | null = null
  private defaultVault: VaultConfig | null = null
  private launcher: MilvusLauncherLike | null = null
  private client: MilvusClient | null = null
  private milvusVersion: string | null = null
  private milvusError: string | null = null
  private embedderStore: Embedder | null = null
  // True when hooks.embedder supplied the embedder: that seam stays
  // authoritative across card settings applies (TASK-004 never drops it).
  private readonly embedderSeamProvided: boolean
  private indexer: IndexerLike | null = null
  private teardownRegistered = false
  private teardownPromise: Promise<void> | null = null
  // The single in-flight card-settings apply (TASK-004 ordering guard);
  // a second concurrent updateCardSettings/resetCardSettings rejects.
  private cardSettingsApplying: Promise<CardSettingsView> | null = null

  /**
   * @param ctx - the cordis context the seam mounts into.
   * @param config - the mounted row config; every field defaults, `{}` is complete.
   * @param hooks - the test seams; production passes none.
   */
  constructor(ctx: Context, config: ObsidianMemConfig = {}, hooks: ObsidianMemHooks = {}) {
    super(ctx, OBSIDIAN_MEM_SEAM)
    this.homedir = hooks.homedir ?? osHomedir
    this.fs = hooks.fs ?? nodeServiceFs
    this.log = ctx.logger('obsidian-mem')

    // One validation pass here (cordis validated the raw row config before
    // calling; this re-validation of the already-resolved value is
    // idempotent) so hand-constructed instances run on a complete config
    // and the unknown-key list rides in on the resolved value's symbol.
    const validated = validateObsidianMemConfig(config)
    if (validated.issues !== undefined) {
      throw new Error(`obsidian-mem config rejected: ${validated.issues.map((i) => i.message).join('; ')}`)
    }
    const resolved = validated.value
    const unknownKeys = (resolved as { [UNKNOWN_CONFIG_KEYS]?: string[] })[UNKNOWN_CONFIG_KEYS]
    // Card overrides merge over the row BEFORE path resolution, so `~` and
    // the '' sentinel defaults in an override resolve exactly like row
    // values (the README promise for card-edited paths).
    this.rowConfig = resolveServiceConfig(resolved, this.homedir())
    this.config = resolveServiceConfig(this.applySettingsOverrides(resolved), this.homedir())
    // Warn-don't-die: unknown keys never reach this.config (defaults only)
    // and never stop the plugin; the author just hears what was ignored.
    if (unknownKeys !== undefined && unknownKeys.length > 0) {
      this.log.warn(`ignoring unknown obsidian-mem config keys: ${unknownKeys.join(', ')}`)
    }

    this.launcherFactory = hooks.launcherFactory
      ?? ((options) => new MilvusLauncher(options))
    this.clientFactory = hooks.clientFactory
      ?? ((address) => readyMilvusClient(address))
    this.indexerFactory = hooks.indexerFactory ?? null
    this.prewarm = hooks.prewarm ?? defaultUvxPrewarm
    this.auditFs = hooks.auditFs ?? nodeAuditFs
    this.embedderStore = hooks.embedder ?? null
    this.embedderSeamProvided = hooks.embedder !== undefined
  }

  /**
   * Cordis runs this after construction; the seam intentionally activates
   * inertly (Decision log: activation must stay side-effect free), so
   * provisioning lives behind ensureMemoryAccess, not here.
   */
  [Service.init](): void {
    // Intentionally empty: nothing may happen at activation.
  }

  /**
   * EnsureMemoryAccess is the idempotent lazy-provisioning seam. The first
   * caller runs the provisioning pass and receives the one-time default-
   * vault notice (when a default was provisioned); later and concurrent
   * callers await the same pass and get `undefined`. A failed pass clears
   * the flight so the next call may retry.
   */
  async ensureMemoryAccess(): Promise<string | undefined> {
    if (this.phase === 'ready' || this.phase === 'degraded') {
      return undefined
    }
    const isTrigger = this.access === null
    this.access ??= {
      promise: this.provision().catch((error: unknown) => {
        this.access = null
        this.phase = 'inactive'
        throw error
      }),
    }
    const notice = await this.access.promise
    return isTrigger ? notice : undefined
  }

  /** ListVaults returns the live registry; it never provisions. */
  listVaults(): VaultEntry[] {
    return this.loadRegistry().vaults.map((entry) => ({ ...entry }))
  }

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
  globalMemorySources(): GlobalMemorySource[] {
    const sources: GlobalMemorySource[] = []
    for (const vault of this.listVaults()) {
      if (vault.mode !== VAULT_MODE_SHARED) {
        continue
      }
      const path = globalFilePath(vault)
      if (path === null) {
        this.log.debug(`global memory file escapes vault ${vault.path} (skipped): ${vault.globalFile}`)
        continue
      }
      const content = this.fs.readFile(path)
      if (content === null) {
        this.log.debug(`global memory file missing or unreadable (skipped): ${path}`)
        continue
      }
      sources.push({ vaultPath: vault.path, path, content })
    }
    return sources
  }

  /**
   * AddVault registers a card-side vault: `shared` paths are created
   * (root + `.obsidian-mem/metadata/`), `read-only` paths must already
   * exist, duplicates are refused with the current registration named, and
   * settings-managed paths cannot be shadowed. `globalFile` is resolved
   * through core resolveGlobalFile (blank or omitted → the layout default)
   * and refused when it is absolute or climbs with `..`. New card vaults
   * persist to <stateDir>/vaults.json atomically.
   */
  addVault(request: VaultAddRequest): VaultEntry {
    const mode = request.mode ?? VAULT_MODE_SHARED
    if (!isVaultMode(mode)) {
      throw new Error(`obsidian-mem addVault: mode must be one of ${VAULT_MODES.join(' | ')}, got "${mode}"`)
    }
    const globalFile = resolveGlobalFile(request.globalFile)
    const globalFileIssue = globalFileShapeIssue(globalFile)
    if (globalFileIssue !== null) {
      throw new Error(
        `obsidian-mem addVault: globalFile ${globalFileIssue}, got "${request.globalFile ?? ''}"`,
      )
    }
    const rawPath = expandHomePath(request.path, this.homedir())
    const registry = this.loadRegistry()

    if (mode === VAULT_MODE_SHARED) {
      // The vault root IS the note root: provisioning creates root +
      // .obsidian-mem/metadata only, never a markdown/ dir.
      this.fs.mkdirp(rawPath)
      this.fs.mkdirp(metadataDir(rawPath))
    } else if (!this.fs.exists(rawPath)) {
      throw new Error(
        `obsidian-mem addVault: read-only vault ${rawPath} does not exist; `
        + 'read-only mode indexes an existing vault, it does not create one',
      )
    }

    const canonical = this.canonicalize(rawPath)
    const existing = registry.vaults.find((entry) => this.canonicalize(entry.path) === canonical)
    if (existing !== undefined) {
      throw new Error(this.duplicateVaultMessage(existing, mode))
    }

    const entry: VaultEntry = {
      path: canonical,
      mode,
      globalFile,
      source: 'card',
    }
    this.commitRegistryMutation((vaults) => {
      vaults.push(entry)
    })
    return { ...entry }
  }

  /**
   * CommitRegistryMutation is the ONE card-registry mutation seam: apply
   * the change to the live registry, rewrite vaults.json, and re-form the
   * indexer, so add and remove cannot fork the persist/restart pair. The
   * provision-time default-vault push is the deliberate exception: it is
   * never persisted, and provisioning owns its own indexer start.
   */
  private commitRegistryMutation(mutate: (vaults: VaultEntry[]) => void): void {
    mutate(this.loadRegistry().vaults)
    this.persistVaultsFile()
    this.restartIndexer()
  }

  /**
   * RemoveVault drops a card-added vault: its chunks are deleted from the
   * collection by the vault filter (when the index is live), its
   * read-registry entries and vaults.json record go, and the indexer
   * re-forms without it. Settings-configured and auto-provisioned default
   * vaults refuse with the actionable place to remove them.
   */
  async removeVault(path: string): Promise<void> {
    const target = this.canonicalize(expandHomePath(path, this.homedir()))
    const registry = this.loadRegistry()
    const index = registry.vaults.findIndex((entry) => this.canonicalize(entry.path) === target)
    if (index === -1) {
      throw new Error(`obsidian-mem removeVault: ${target} is not a registered vault`)
    }
    const entry = registry.vaults[index]!
    if (entry.source === 'settings') {
      throw new Error(
        `obsidian-mem removeVault: ${target} is managed by the obsidian-mem-service row config.vaults; `
        + 'remove it there (settings), not from the card',
      )
    }
    if (entry.source === 'default') {
      throw new Error(
        `obsidian-mem removeVault: ${target} is the auto-provisioned default vault; `
        + 'register a shared vault (card or config.vaults) to take over, then restart',
      )
    }

    this.commitRegistryMutation((vaults) => {
      vaults.splice(index, 1)
    })
    for (const readPath of [...this.readRegistry.keys()]) {
      if (readPath.startsWith(`${target}/`) || readPath.startsWith(`${target}\\`)) {
        this.readRegistry.delete(readPath)
      }
    }
    // The seam already re-formed the indexer without this vault; purging
    // its rows in the collection is independent Milvus work.
    await this.dropVaultChunks(entry.path)
  }

  /**
   * Read returns a note's meta plus a 1-based line slice of its body, and
   * updates the frontmatter read stats (read_count +1, last_read_at=today)
   * for shared vaults via the raw-preserving serializer; read-only vaults
   * skip the stats write and answer statsUpdated: false. Every read
   * records {contentHash, mtimeMs, at} in the read registry for the
   * memory_write staleness guard (TASK-033).
   */
  async read(
    absPath: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<ObsidianMemReadResult> {
    await this.ensureMemoryAccess()
    const target = expandHomePath(absPath, this.homedir())
    const classified = classifyPath(this.listVaults(), target)
    if (classified === null) {
      throw new Error(`obsidian-mem read: ${target} is not inside any registered vault`)
    }
    const text = this.fs.readFile(target)
    if (text === null) {
      throw new Error(`obsidian-mem read: ${target} does not exist or is not readable`)
    }
    const note = parseNote(text)
    const stat = this.fs.stat(target)

    let statsUpdated = false
    let finalText = text
    if (classified.mode === VAULT_MODE_SHARED) {
      const nextMeta: NoteMeta = {
        ...note.meta,
        read_count: note.meta.read_count + 1,
        last_read_at: formatLocalDate(new Date()),
      }
      finalText = serializeNoteWithRaw({ meta: nextMeta, body: note.body }, note.raw)
      this.writeAtomic(target, finalText)
      statsUpdated = true
      note.meta = nextMeta
    }

    // The registry records the bytes the plugin last produced, so the
    // write-staleness guard compares against post-bump content, not the
    // pre-read state a stats write just replaced.
    this.readRegistry.set(target, {
      contentHash: contentHash(finalText),
      mtimeMs: stat?.mtimeMs ?? 0,
      at: Date.now(),
    })

    // One trailing newline is a terminator, not a line: without the trim
    // every whole-body read would report a phantom empty last line.
    const lines = note.body.replace(/\n$/, '').split('\n')
    const totalLines = lines.length
    const offset = Math.max(1, Math.trunc(options.offset ?? 1))
    const limit = options.limit === undefined ? totalLines : Math.max(0, Math.trunc(options.limit))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    return {
      path: target,
      meta: note.meta,
      body: slice.join('\n'),
      mode: classified.mode,
      statsUpdated,
      offset,
      limit,
      totalLines,
      truncated: offset - 1 + slice.length < totalLines,
    }
  }

  /**
   * Write orchestrates a note write end to end: meta validation (core
   * validateMeta errors throw), then applyWrite. The path-scoping,
   * staleness, and read-only guard conversation live in the memory_write
   * tool (TASK-033); this stays the single write-through primitive chain.
   */
  async write(request: ObsidianMemWriteRequest): Promise<ObsidianMemWriteResult> {
    const { errors } = validateMeta(request.meta)
    if (errors.length > 0) {
      throw new Error(`obsidian-mem write rejected: ${errors.join('; ')}`)
    }
    return await this.applyWrite(request.path, request.meta, request.body)
  }

  /**
   * ApplyWrite merges the parsed frontmatter of an existing file back in
   * before serializing (TASK-025 carry-over #1: serializeNote renders the
   * modelled keys only, so keywords/trigger_extensions and every other
   * un-modelled author key would otherwise be silently dropped on
   * rewrite), writes atomically, updates the read registry, and hands the
   * path to the indexer's write-through queue. Read-only vaults refuse.
   */
  async applyWrite(
    path: string,
    meta: NoteMeta,
    body: string,
  ): Promise<ObsidianMemWriteResult> {
    await this.ensureMemoryAccess()
    const target = expandHomePath(path, this.homedir())
    const classified = classifyPath(this.listVaults(), target)
    if (classified === null) {
      throw new Error(`obsidian-mem write: ${target} is not inside any registered vault`)
    }
    if (classified.mode !== VAULT_MODE_SHARED) {
      throw new Error(`obsidian-mem write: ${target} lies in read-only vault ${classified.vault.path}`)
    }
    // Reserved protocol files (.INTENTS.md, DREAMS.md, <slug>_history.md)
    // are never authored-note targets; the note dir itself is checked next.
    const fileName = target.slice(Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1)
    if (target.startsWith(`${classified.vault.path}${sep}`)
      && target.slice(classified.vault.path.length + 1).indexOf(sep) === -1
      && isReservedNonIndexed(fileName)) {
      throw new Error(`obsidian-mem write: ${target} is a reserved non-indexed vault file`)
    }
    if (!classified.insideNotes) {
      throw new Error(
        `obsidian-mem write: ${target} is outside the indexed note tree of vault ${classified.vault.path}`,
      )
    }

    const existing = this.fs.readFile(target)
    const created = existing === null
    const raw = existing === null ? undefined : parseNote(existing).raw
    const rendered = serializeNoteWithRaw({ meta, body }, raw)
    this.fs.mkdirp(dirname(target))
    this.writeAtomic(target, rendered)

    const written = this.fs.stat(target)
    this.readRegistry.set(target, {
      contentHash: contentHash(rendered),
      mtimeMs: written?.mtimeMs ?? 0,
      at: Date.now(),
    })

    // The indexer normalizes both vault-relative and vault-absolute forms;
    // the root-relative form is what "relPath" means to its callers.
    const relPath = relative(classified.vault.path, target)
    const indexer = this.indexer
    if (indexer !== null) {
      // Write-through reindex: the note is searchable the moment the file
      // write lands. A cold/degraded indexer keeps the watcher's dirt.
      await indexer.indexFile(classified.vault.path, relPath).catch((error: unknown) => {
        this.log.warn(`write-through index failed for ${target}: ${describeError(error)}`)
      })
    }
    return { path: target, created, vaultPath: classified.vault.path, relPath }
  }

  /**
   * Search routes through ensureMemoryAccess and the shared hybridSearch
   * pipeline; an offline or crashed index answers with the typed
   * IndexOfflineError callers degrade quietly on, never a hang or crash.
   */
  async search(request: SearchRequest): Promise<MemorySearchResult[]> {
    await this.ensureMemoryAccess()
    return await hybridSearch({
      // Structural casts of the whole client to the narrow slices search
      // and the indexer declare: the SDK's overloaded method unions do not
      // line up with the plain shapes under exactOptionalPropertyTypes,
      // while the dispatched request shapes are the verified ones
      // (milvus-live.spec, search.spec, indexer.spec).
      client: this.searchClient() as unknown as SearchDependencies['client'],
      embedder: this.getEmbedder(),
      vaultModeFor: (vault) => this.modeForVaultValue(vault),
      defaultTokenCap: this.config.budgets.readSectionTokens,
    }, request)
  }

  /**
   * SearchExactSections routes the Read intercept (TASK-042) through
   * ensureMemoryAccess and the shared exact-section pipeline, with the same
   * offline discipline as `search` (typed IndexOfflineError, never a hang).
   */
  async searchExactSections(request: ExactSectionRequest): Promise<MemorySearchResult[]> {
    await this.ensureMemoryAccess()
    return await searchExactSections({
      client: this.searchClient() as unknown as SearchDependencies['client'],
      embedder: this.getEmbedder(),
      vaultModeFor: (vault) => this.modeForVaultValue(vault),
      defaultTokenCap: this.config.budgets.readSectionTokens,
    }, request)
  }

  // The offline discipline both search entries share: a never-started or
  // degraded index answers the typed IndexOfflineError, never a crash.
  private searchClient(): MilvusClient {
    const client = this.client
    if (client === null) {
      throw new IndexOfflineError(
        `memory index is offline${this.milvusError === null ? '' : `: ${this.milvusError}`}`,
      )
    }
    if (this.launcher?.degraded === true) {
      throw new IndexOfflineError('milvus child died; a respawn is pending, retry shortly')
    }
    return client
  }

  /** Status answers the card and audit without triggering provisioning. */
  status(): ObsidianMemStatus {
    const registry = this.registry
    return {
      state: this.phase,
      notice: this.defaultVault === null ? null : this.noticeText,
      defaultVaultPath: this.defaultVault?.path ?? null,
      vaults: registry === null ? [] : registry.vaults.map((entry) => ({ ...entry })),
      vectorDim: this.config.vectorDim,
      model: { ...this.config.model },
      milvus: {
        mode: this.config.milvus.mode,
        address: this.launcher?.address ?? null,
        dbPath: this.config.milvus.dbPath,
        version: this.milvusVersion,
        degraded: this.launcher?.degraded ?? false,
        error: this.milvusError,
        readinessTimeoutMs: this.config.milvus.readinessTimeoutMs,
      },
      indexer: this.indexer?.progress() ?? null,
      budgets: { ...this.config.budgets },
      dreaming: {
        ...this.config.dreaming,
        schedules: this.config.dreaming.schedules.map((s) => ({ ...s })),
      },
      dream: this.dreamStatus(),
    }
  }

  // DreamStatus snapshots the orchestrator lazily; constructing it never
  // touches disk, and the only read per status() poll is the state stamp.
  private dreamStatus(): ObsidianMemDreamStatus {
    const engine = this.dreamEngine()
    const last = engine.lastSummary
    return {
      state: engine.busy ? 'running' : 'idle',
      blocked: engine.blockedReason(),
      lastDreamAt: engine.lastDreamAt(),
      lastRun: last === null ? null : { ...last, archiveCandidates: [...last.archiveCandidates] },
    }
  }

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
  cardSettings(): CardSettingsView {
    const { settings, overrides } = this.effectiveCardSettings()
    return {
      settings,
      overrides,
      restartPending: differingCardSettingsPaths(settings, this.config),
    }
  }

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
  async updateCardSettings(patch: CardSettingsPatch): Promise<CardSettingsView> {
    const unset = patch.unset ?? []
    const rejected: string[] = []
    // Validation use of the whitelist walker: the kept tree is discarded,
    // every non-whitelisted path reports into `rejected`.
    filterCardSettingsTree(patch.set ?? {}, rejected)
    for (const path of unset) {
      if (!CARD_SETTINGS_KEYS.includes(path)) rejected.push(path)
    }
    if (rejected.length > 0) {
      throw new Error(
        `obsidian-mem card settings rejected: not card-editable: ${rejected.join(', ')}`,
      )
    }

    const overrides = this.readSettingsOverrides()
    for (const path of unset) {
      removeCardSettingsPath(overrides, path)
    }
    mergeCardSettingsPatch(overrides, patch.set ?? {})
    // The draft IS the record about to be written: the row merged with the
    // full new override tree, so a hand-corrupted stored key rejects the
    // apply instead of being persisted and silently dropped at boot.
    const draft = validateMergedCardSettings(this.rowConfig, overrides)
    if (draft.issues !== undefined) {
      throw new Error(
        `obsidian-mem card settings rejected: ${draft.issues.map((issue) => issue.message).join('; ')}`,
      )
    }
    return this.commitCardSettings(overrides)
  }

  /**
   * ResetCardSettings ("Reset all to profile settings") clears every
   * stored override: the file keeps its version stamp with an empty
   * overrides object, a dbPath the overrides had moved goes back to the
   * row's state dir via the vaults.json carry, the escalation re-applies
   * toward the row values, and the fresh view answers. Same rejection
   * behavior as {@link ObsidianMemService.updateCardSettings}.
   */
  async resetCardSettings(): Promise<CardSettingsView> {
    return this.commitCardSettings({})
  }

  /**
   * GlobalMemoryIndex is the global recall-budget view (TASK-045): the
   * configured budget against the recall tokens the wired
   * {@link ObsidianMemService.sessionRegistry} sums across every session it
   * knows. Before the events row wires a registry the view reports zero
   * use (nothing has been injected since the last successful dream or
   * host restart).
   */
  globalMemoryIndex(): GlobalMemoryIndex {
    const budgetTokens = this.config.budgets.globalMemoryTokens
    const usedTokens = this.sessionRegistryValue?.totalRecallTokensUsed() ?? 0
    return {
      budgetTokens,
      usedTokens,
      remainingTokens: Math.max(0, budgetTokens - usedTokens),
      overBudget: isOverGlobalBudget(usedTokens, budgetTokens),
    }
  }

  /**
   * SetSessionRegistry wires the events-owned SessionRegistry (TASK-040
   * seam change): the events package constructs and owns the registry, the
   * service just holds the reference so TASK-045's global budget accounting
   * can read session usage without importing events. Passing null unwires
   * (the events row unloading).
   */
  setSessionRegistry(registry: SessionRegistryView | null): void {
    this.sessionRegistryValue = registry
  }

  /** SessionRegistry is the events-wired registry, or null before it mounts. */
  get sessionRegistry(): SessionRegistryView | null {
    return this.sessionRegistryValue
  }

  /**
   * Audit drives the read-only doctor pass (TASK-034). It never provisions
   * and never writes: the registry comes from the sync read path, the
   * filesystem walk goes through the read-only AuditFs seam, and a live
   * collection is contacted only through one probe (describe + statistics)
   * when the index already reports ready.
   */
  async audit(request: AuditRequest = {}): Promise<AuditReport> {
    const collection = this.client === null
      ? null
      : async (): Promise<CollectionProbeResult> => await this.probeCollection()
    return await runStoreAudit({
      vaults: this.listVaults(),
      status: this.status(),
      config: this.config,
      globalIndex: this.globalMemoryIndex(),
      homedir: this.homedir(),
      fs: this.auditFs,
      collection,
    }, request)
  }

  // One describe + one statistics read; every Milvus failure comes back as
  // the typed probe result (reachable:false + error), never a throw, so a
  // dead child degrades into report lines instead of killing the audit.
  private async probeCollection(): Promise<CollectionProbeResult> {
    const client = this.client
    if (client === null) {
      return { reachable: false, exists: false, dim: null, count: null, error: 'no live client' }
    }
    try {
      const has = assertOk(
        await client.hasCollection({ collection_name: MILVUS_COLLECTION }),
        'audit hasCollection',
      ).value
      if (!has) {
        return { reachable: true, exists: false, dim: null, count: null, error: null }
      }
      const described = assertOk(
        await client.describeCollection({ collection_name: MILVUS_COLLECTION }),
        'audit describeCollection',
      )
      const statistics = assertOk(
        await client.getCollectionStatistics({ collection_name: MILVUS_COLLECTION }),
        'audit getCollectionStatistics',
      )
      const rowCount = (statistics.stats ?? []).find((entry) => entry.key === 'rowCount')?.value
      const count = rowCount === undefined ? null : Number(rowCount)
      return {
        reachable: true,
        exists: true,
        dim: storedDenseDim(described),
        count: count !== null && Number.isFinite(count) ? count : null,
        error: null,
      }
    } catch (error: unknown) {
      return { reachable: false, exists: false, dim: null, count: null, error: describeError(error) }
    }
  }

  /**
   * Dream drives the compaction orchestrator (TASK-035). `plan` answers the
   * deterministic analysis; `run` arms the single-flight guard, launches a
   * dedicated dream agent through the reflection gateway `ctx.get('agents')`
   * (never a typed agents import), and answers {id, done} immediately: the
   * CALLER attaches a swallowing logging catch to done and never awaits it
   * inline. Busy and blocked arrive as DreamBusyError / DreamBlockedError;
   * the tool maps them to their kind values.
   */
  async dream(request: DreamRequest = {}): Promise<DreamEngineResult> {
    const engine = this.dreamEngine()
    if ((request.operation ?? 'plan') === 'plan') {
      return { operation: 'plan', plan: await engine.plan() }
    }
    const handle = engine.startRun(request.model === undefined ? {} : { model: request.model })
    return { operation: 'run', id: handle.id, done: handle.done }
  }

  private dreamEngine(): DreamOrchestrator {
    if (this.dreamEngineValue === null) {
      this.dreamEngineValue = new DreamOrchestrator({
        fs: this.fs,
        config: this.config,
        // Same enumeration the audit walks: one inventory, two consumers.
        inventories: (): VaultInventory[] => this.listVaults().map((entry) => inventoryVault(entry, this.auditFs)),
        globalIndex: () => this.globalMemoryIndex(),
        agentsGateway: () => this.ctx.get('agents') as DreamAgentsGateway | undefined,
        // Same reflection-gateway pattern as agentsGateway above: ctx.get
        // answers undefined for an unmounted service, so no try/catch.
        defaultAgentOptions: () => (this.ctx.get('agentDefaultModel') as DreamDefaultModelGateway | undefined)?.currentSelection() ?? undefined,
        noteVectors: (targets) => this.fetchNoteVectors(targets),
        // Successful compaction rebaselines the global recall budget
        // (PLAN-budget-rebaseline TASK-002): the closure reads the wired
        // registry at call time, and no-ops before the events row wires one.
        onRunSucceeded: () => { this.sessionRegistryValue?.resetRecallUsage() },
        log: (message) => {
          this.log.info(`dream: ${message}`)
        },
      })
    }
    return this.dreamEngineValue
  }

  // One bounded query per candidate note: stored chunk vectors, averaged
  // into a single pseudo-embedding for near-duplicate clustering. Any row
  // miss leaves the note out of clustering (the plan says so).
  private async fetchNoteVectors(targets: readonly DreamVectorTarget[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>()
    const client = this.client
    if (client === null) {
      return out
    }
    for (const target of targets) {
      try {
        const res = assertOk(
          await client.query({
            collection_name: MILVUS_COLLECTION,
            expr: `${MILVUS_FIELDS.sourcePath} == ${quoteExpr(target.rel)} && ${MILVUS_FIELDS.vault} == ${quoteExpr(vaultKey(target.vaultPath))}`,
            output_fields: [MILVUS_FIELDS.denseVector],
            limit: DREAM_VECTOR_QUERY_LIMIT,
          }),
          'dream noteVectors query',
        )
        const vectors = res.data
          .map((row) => row[MILVUS_FIELDS.denseVector])
          .filter((vector): vector is number[] => Array.isArray(vector))
        if (vectors.length === 0) {
          continue
        }
        const dim = (vectors[0] as number[]).length
        const mean = new Array<number>(dim).fill(0)
        for (const vector of vectors) {
          for (let i = 0; i < dim; i += 1) {
            mean[i] = (mean[i] as number) + ((vector[i] as number) ?? 0) / vectors.length
          }
        }
        out.set(target.path, mean)
      } catch (error: unknown) {
        this.log.warn(`dream: noteVectors query failed for ${target.path}: ${describeError(error)}`)
      }
    }
    return out
  }

  /**
   * ReadRecord answers the write-staleness guard (TASK-033): what the
   * plugin last saw at this path through read/applyWrite, or undefined
   * when the plugin never touched it.
   */
  readRecord(absPath: string): ReadRegistryEntry | undefined {
    return this.readRegistry.get(expandHomePath(absPath, this.homedir()))
  }

  /** Stop tears effects down once: indexers stop, the child dies, the client closes. */
  stop(): Promise<void> {
    this.teardownPromise ??= this.teardown()
    return this.teardownPromise
  }

  // The one-time provisioning pass; see ensureMemoryAccess for ordering.
  private async provision(): Promise<string | undefined> {
    this.phase = 'provisioning'
    const registry = this.loadRegistry()

    // 1. Zero shared vaults -> provision the default vault + seed .INTENTS.
    let notice: string | undefined
    if (firstSharedVault(registry.vaults) === null) {
      const fresh = provisionDefaultVault(this.vaultFs(), this.homedir())
      // realpath so the registry stays canonical like resolveVaults output.
      fresh.path = this.canonicalize(fresh.path)
      seedIntentsFile(this.vaultFs(), fresh.path)
      const entry: VaultEntry = { ...fresh, source: 'default' }
      registry.vaults.push(entry)
      this.defaultVault = fresh
      notice = `Obsidian Mem is using the default memory vault at ${fresh.path}. `
        + 'Add your own vaults in the Obsidian Mem settings card to override.'
      this.noticeText = notice
      this.log.info(`provisioned default vault ${fresh.path}`)
    }

    // 2. dbDir + state dir for vaults.json and the lite data dir.
    this.fs.mkdirp(this.config.milvus.dbPath)
    this.fs.mkdirp(this.stateDirPath())

    // 3. Best-effort background uvx warm (G13 cold starts run into minutes).
    if (this.config.milvus.mode === 'spawn') {
      try {
        this.prewarm('uvx', [
          '--with', 'pymilvus',
          '--from', `milvus-lite==${MILVUS_LITE_VERSION}`,
          'milvus-lite', '--help',
        ])
      } catch (error: unknown) {
        // The launcher resolves/installs uv itself; a missing warm changes
        // only first-run latency, never correctness.
        this.log.debug(`uvx pre-warm skipped: ${describeError(error)}`)
      }
    }

    // Teardown is registered before anything exists to tear down, so a
    // dispose during the pass still unwinds whatever lands later.
    this.registerTeardown()

    // 4. Milvus start with the G13 readiness budget, then G12: the
    //    long-lived client is created ONLY against a answered server.
    const launcher = this.launcherFactory({
      config: {
        mode: this.config.milvus.mode,
        ...(this.config.milvus.address === '' ? {} : { address: this.config.milvus.address }),
        dataDir: this.config.milvus.dbPath,
      },
      homedir: this.homedir,
      readinessTimeoutMs: this.config.milvus.readinessTimeoutMs,
      log: (message) => { this.log.warn(message) },
    })
    this.launcher = launcher
    let address: string
    try {
      const started = await launcher.start()
      address = started.address
      this.milvusVersion = started.version
    } catch (error: unknown) {
      // Degraded, not dead: status reports, search answers
      // IndexOfflineError, the harness never sees a crash.
      this.milvusError = describeError(error)
      this.phase = 'degraded'
      this.log.error(`memory index degraded: milvus start failed: ${this.milvusError}`)
      return notice
    }

    try {
      const client = await this.clientFactory(address)
      this.client = client

      // 5. Collection; dim/sparse drift is answered by a rebuild plus a
      //    forced full reindex (the vault state files are dropped so the
      //    indexer treats every file as new against the rebuilt collection).
      const collection = await ensureCollection(client, { dim: this.config.vectorDim })
      if (collection.needsRebuild) {
        this.log.warn(
          `collection drift (stored dim ${collection.storedDim ?? 'unknown'}, wanted `
          + `${this.config.vectorDim}); rebuilding and forcing a full reindex`,
        )
        await rebuildCollection(client, { dim: this.config.vectorDim })
        this.dropVaultStateFiles()
      }

      // 6. Indexer background start (full-scan + watchers).
      this.indexer = this.buildIndexer()
      this.indexer.start()
    } catch (error: unknown) {
      this.milvusError = describeError(error)
      this.phase = 'degraded'
      this.log.error(`memory index degraded after readiness: ${this.milvusError}`)
      return notice
    }

    this.phase = 'ready'
    return notice
  }

  // Current vault registry (config + card + provisioned default), loaded
  // and validated once; reads vaults.json without ever writing it.
  private loadRegistry(): VaultRegistryView {
    if (this.registry !== null) return this.registry
    const probe: FsProbe = {
      exists: (path) => this.fs.exists(path),
      realpath: (path) => this.fs.realpath(path),
    }
    const settings = resolveVaults(this.config.vaults, probe)
    const card = resolveVaults(this.readVaultsFile(), probe)
    const vaults: VaultEntry[] = []
    const seen = new Set<string>()
    for (const vault of settings.vaults) {
      vaults.push({ ...vault, source: 'settings' })
      seen.add(vault.path)
    }
    for (const vault of card.vaults) {
      if (seen.has(vault.path)) {
        this.log.warn(`vaults.json entry ${vault.path} duplicates a settings vault; ignored`)
        continue
      }
      vaults.push({ ...vault, source: 'card' })
      seen.add(vault.path)
    }
    for (const rejection of [...settings.rejected, ...card.rejected]) {
      this.log.warn(`vault ${rejection.config.path} rejected (${rejection.kind}); not registered`)
    }
    this.registry = { vaults }
    return this.registry
  }

  // Card vaults from <stateDir>/vaults.json; a corrupt file is logged and
  // treated as empty (self-healing persistence), never a dead plugin.
  // Entries missing globalFile (files written before TASK-004) reach core
  // resolveVaults without the key and default through resolveGlobalFile.
  private readVaultsFile(): VaultFileEntry[] {
    const raw = this.fs.readFile(this.vaultsFilePath())
    if (raw === null) return []
    try {
      const parsed = JSON.parse(raw) as Partial<VaultFileRecord>
      return Array.isArray(parsed.vaults)
        ? parsed.vaults
          .filter((v): v is VaultFileEntry & { path: string; mode: string } => (
            typeof v?.path === 'string' && typeof v?.mode === 'string'
          ))
          .map((v) => ({
            path: v.path,
            mode: v.mode,
            // A non-string globalFile (hand-edited junk) is dropped so the
            // core default, not the junk, wins.
            ...(typeof v.globalFile === 'string' ? { globalFile: v.globalFile } : {}),
          }))
        : []
    } catch (error: unknown) {
      this.log.warn(`vaults.json unreadable (${this.vaultsFilePath()}): ${describeError(error)}; starting empty`)
      return []
    }
  }

  private persistVaultsFile(): void {
    const registry = this.loadRegistry()
    const record: VaultFileRecord = {
      version: VAULTS_FILE_VERSION,
      vaults: registry.vaults
        .filter((entry) => entry.source === 'card')
        .map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          // The file stores the resolved value, so every rewrite makes old
          // files self-describing; loading still tolerates a missing key.
          globalFile: entry.globalFile,
        })),
    }
    this.fs.mkdirp(this.stateDirPath())
    this.writeAtomic(this.vaultsFilePath(), `${JSON.stringify(record, null, 2)}\n`)
  }

  /**
   * ApplySettingsOverrides merges the whitelisted card overrides from
   * settings.json over the validated row config, card winning per leaf key
   * (the card edit is the newer user intent). A merged value that fails
   * schema re-validation (hand-edited junk) falls back to the row-only
   * config with a warn: a bad settings file costs its own edits, never the
   * boot. Runs before resolveServiceConfig.
   */
  private applySettingsOverrides(resolved: ResolvedObsidianMemConfig): ResolvedObsidianMemConfig {
    const overrides = this.readSettingsOverrides()
    if (Object.keys(overrides).length === 0) return resolved
    const merged = validateMergedCardSettings(resolved, overrides)
    if (merged.issues !== undefined) {
      this.log.warn(
        `${SETTINGS_FILE_NAME} overrides rejected: `
        + `${merged.issues.map((issue) => issue.message).join('; ')}; using the row config only`,
      )
      return resolved
    }
    return merged.value
  }

  // Card overrides from settings.json: a missing file answers {}, a corrupt
  // one is logged and answers {} (self-healing persistence, the vaults.json
  // precedent), a version newer than this plugin's is ignored, and keys
  // outside CARD_SETTINGS_KEYS are dropped with a warn naming them.
  private readSettingsOverrides(): Record<string, unknown> {
    const path = this.settingsFilePath()
    const raw = this.fs.readFile(path)
    if (raw === null) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      this.log.warn(`${SETTINGS_FILE_NAME} unreadable (${path}): ${describeError(error)}; starting without overrides`)
      return {}
    }
    if (!isRecord(parsed)) {
      this.log.warn(`${SETTINGS_FILE_NAME} malformed (${path}); starting without overrides`)
      return {}
    }
    const record = parsed as Partial<SettingsFileRecord>
    if (typeof record.version === 'number' && record.version > SETTINGS_FILE_VERSION) {
      this.log.warn(
        `${SETTINGS_FILE_NAME} version ${String(record.version)} is newer than this plugin understands; `
        + 'ignoring its overrides',
      )
      return {}
    }
    if (!isRecord(record.overrides)) return {}
    const dropped: string[] = []
    const kept = filterCardSettingsTree(record.overrides, dropped)
    if (dropped.length > 0) {
      this.log.warn(`ignoring non card-editable ${SETTINGS_FILE_NAME} keys: ${dropped.join(', ')}`)
    }
    return kept
  }

  // CommitCardSettings is the ONE persistence tail both updateCardSettings
  // and resetCardSettings share, and the home of the single in-flight
  // guard (TASK-004): while one apply chain runs, any other commit throws
  // (rejects at the public boundary) before it persists. The chain itself
  // (applyCardSettings) persists, carries, escalates, then answers the
  // fresh view (so restartPending reflects what the escalation did not
  // apply in-process).
  private commitCardSettings(overrides: Record<string, unknown>): Promise<CardSettingsView> {
    if (this.cardSettingsApplying !== null) {
      throw new Error(
        'obsidian-mem card settings rejected: another apply is still in flight; retry once it answers',
      )
    }
    const applying = this.applyCardSettings(overrides)
    this.cardSettingsApplying = applying
    const clear = (): void => {
      if (this.cardSettingsApplying === applying) this.cardSettingsApplying = null
    }
    applying.then(clear, clear)
    return applying
  }

  // The apply chain behind commitCardSettings: snapshot the persisted
  // view, write the record atomically, carry vaults.json forward when the
  // persisted milvus.dbPath moved, run the single live-apply call site,
  // then answer the fresh view.
  private async applyCardSettings(overrides: Record<string, unknown>): Promise<CardSettingsView> {
    const before = this.effectiveCardSettings().settings
    this.persistSettingsOverrides(overrides)
    const after = this.effectiveCardSettings().settings
    const changed = differingCardSettingsPaths(before, after)
    if (changed.includes('milvus.dbPath')) {
      this.copyVaultsFileToStateDir(dbStateDir(after.milvus.dbPath))
    }
    await this.escalateCardSettings(changed, after)
    return this.cardSettings()
  }

  // EffectiveCardSettings is the persisted view cardSettings displays: the
  // profile row re-merged with settings.json and run through
  // resolveServiceConfig, so `~` and the '' sentinels in a stored override
  // expand exactly like row values, the slice carries resolved paths, and
  // an `unset` leaf really returns its row value (this.config may still
  // carry the value it booted with). A merged draft that fails schema
  // validation (a file hand-edited after boot) answers the running values
  // instead, the boot fallback mirrored; `overrides` always answer exactly
  // what the file stored.
  private effectiveCardSettings(): {
    settings: CardEditableConfig
    overrides: CardEditablePartial
  } {
    const overrides = this.readSettingsOverrides()
    const merged = validateMergedCardSettings(this.rowConfig, overrides)
    const settings = merged.issues === undefined
      ? cardEditableSlice(resolveServiceConfig(merged.value, this.homedir()))
      : cardEditableSlice(this.config)
    return { settings, overrides: overrides as CardEditablePartial }
  }

  private persistSettingsOverrides(overrides: Record<string, unknown>): void {
    const record: SettingsFileRecord = { version: SETTINGS_FILE_VERSION, overrides }
    this.fs.mkdirp(this.settingsDirPath())
    this.writeAtomic(this.settingsFilePath(), `${JSON.stringify(record, null, 2)}\n`)
  }

  // CopyVaultsFileToStateDir carries the live vaults.json into targetDir
  // best-effort when a persisted milvus.dbPath change moves where the next
  // host start reads it, so card-registered vaults survive the restart.
  // settings.json itself stays anchored (settingsFilePath); a missing
  // current file is the empty answer, and a failed copy only warns.
  private copyVaultsFileToStateDir(targetDir: string): void {
    try {
      const contents = this.fs.readFile(this.vaultsFilePath())
      if (contents === null) return
      this.fs.mkdirp(targetDir)
      this.writeAtomic(join(targetDir, VAULTS_FILE_NAME), contents)
    } catch (error: unknown) {
      this.log.warn(`vaults.json carry to ${targetDir} failed: ${describeError(error)}`)
    }
  }

  // EscalateCardSettings is the single live-apply call site for an accepted
  // card change (TASK-004), the smallest safe escalation per changed class.
  // It mutates this.config ONLY (INVARIANT: never the rowConfig base) by
  // replacing whole nested groups, then re-forms what the change touches:
  //   budgets.*: object swap; every consumer reads budgets at call time.
  //     budgets.thinkShotsPerTurn additionally reaches the boot-baked
  //     SessionRegistry cap through the view's optional setter.
  //   git.*: object swap only; the git consumers (TASK-004+) read
  //     config.git at call time, so no subsystem re-forms for the swap.
  //   llm.*: object swap plus restartIndexer (buildIndexer reads config.llm).
  //   vectorDim / model.id / model.cacheDir: config swap, drop the lazy
  //     embedder (the hooks.embedder seam stays authoritative), and when
  //     ready re-run the provision step-5 pair on a width move (rebuild +
  //     dropVaultStateFiles) before restartIndexer. Same width or a
  //     cacheDir-only move is just restartIndexer: chunk ids bake
  //     modelId+vectorDim, so the indexer's state diff re-embeds changed
  //     content and stale-deletes the old rows by itself. Not yet
  //     provisioned: the config mutation is enough; provisioning picks the
  //     new values up (dim drift is answered at its step 5 the same way).
  //   milvus.dbPath: persist-only by plan decision; the subsystems keep the
  //     old dir until a restart, and cardSettings' restartPending reports
  //     it (the commit tail's vaults.json carry is its one in-process
  //     effect).
  // An apply landing during 'provisioning' waits the pass out first: that
  // step-5 pair may already have run against the pre-change config, and no
  // client exists before it. A failed re-form restores the snapshotted
  // values so the previous config stays applied, then answers a
  // validation-style error.
  private async escalateCardSettings(
    changed: readonly string[],
    target: CardEditableConfig,
  ): Promise<void> {
    if (changed.length === 0) {
      return
    }
    if (this.phase === 'provisioning' && this.access !== null) {
      // Wait out the in-flight pass, failure included: the phase settles,
      // and a config-only apply stays correct when it never reaches ready.
      await this.access.promise.catch(() => undefined)
    }

    const budgetsChanged = changed.some((key) => key.startsWith('budgets.'))
    const llmChanged = changed.some((key) => key.startsWith('llm.'))
    const gitChanged = changed.some((key) => key.startsWith('git.'))
    const embedderChanged = changed.some((key) => EMBEDDER_CARD_SETTINGS_KEYS.includes(key))
    const dimChanged = changed.includes('vectorDim')
    const thinkShotsChanged = changed.includes('budgets.thinkShotsPerTurn')

    // Snapshot every field this escalation may swap; the catch restores it.
    const previous = {
      budgets: this.config.budgets,
      llm: this.config.llm,
      git: this.config.git,
      model: this.config.model,
      vectorDim: this.config.vectorDim,
      embedder: this.embedderStore,
    }

    if (budgetsChanged) this.config.budgets = { ...target.budgets }
    if (llmChanged) this.config.llm = { ...target.llm }
    if (gitChanged) this.config.git = { ...target.git }
    if (changed.includes('model.id') || changed.includes('model.cacheDir')) {
      // The model group swap keeps the non-card dtype leaf untouched.
      this.config.model = {
        ...this.config.model,
        id: target.model.id,
        cacheDir: target.model.cacheDir,
      }
    }
    if (dimChanged) this.config.vectorDim = target.vectorDim
    if (thinkShotsChanged) {
      this.sessionRegistryValue?.setThinkShotsPerTurn?.(this.config.budgets.thinkShotsPerTurn)
    }
    if (embedderChanged && !this.embedderSeamProvided) {
      this.embedderStore = null
    }

    if (!llmChanged && !embedderChanged) {
      // Pure budgets patch: call-time readers need no further work.
      return
    }

    try {
      const client = this.client
      if (dimChanged && this.phase === 'ready' && client !== null) {
        const collection = await ensureCollection(client, { dim: this.config.vectorDim })
        if (collection.needsRebuild) {
          this.log.warn(
            `card settings: vectorDim moved to ${String(this.config.vectorDim)} `
            + `(stored dim ${String(collection.storedDim ?? 'unknown')}); rebuilding the `
            + 'collection and forcing a full reindex',
          )
          await rebuildCollection(client, { dim: this.config.vectorDim })
          this.dropVaultStateFiles()
        }
      }
      // No-op while the index is not live; provisioning picks the swap up.
      this.restartIndexer()
    } catch (error: unknown) {
      this.config.budgets = previous.budgets
      this.config.llm = previous.llm
      this.config.git = previous.git
      this.config.model = previous.model
      this.config.vectorDim = previous.vectorDim
      if (thinkShotsChanged) {
        this.sessionRegistryValue?.setThinkShotsPerTurn?.(previous.budgets.thinkShotsPerTurn)
      }
      if (embedderChanged && !this.embedderSeamProvided) {
        this.embedderStore = previous.embedder
      }
      // restartIndexer stops the old manager before building the new one,
      // so the rollback re-forms over the restored config rather than
      // leaving a stopped indexer in place.
      try {
        this.restartIndexer()
      } catch (restoreError: unknown) {
        this.log.error(`card settings rollback re-form failed: ${describeError(restoreError)}`)
      }
      this.log.error(
        `card settings apply failed; previous values stay applied: ${describeError(error)}`,
      )
      throw new Error(
        `obsidian-mem card settings apply failed: ${describeError(error)}`,
        { cause: error },
      )
    }
  }

  private writeAtomic(path: string, contents: string): void {
    const tmp = `${path}.obsidian-mem.tmp`
    this.fs.writeFile(tmp, contents)
    this.fs.rename(tmp, path)
  }

  // <dbPath>/state mirrors core's stateDir(homedir) = dbDir/state for the
  // default dbPath, and follows a custom dbPath otherwise; dbStateDir keeps
  // the segment with core's layout definition.
  private stateDirPath(): string {
    return dbStateDir(this.config.milvus.dbPath)
  }

  private vaultsFilePath(): string {
    return join(this.stateDirPath(), VAULTS_FILE_NAME)
  }

  // settings.json anchors at the FIXED core stateDir(homedir), not the
  // config-derived stateDirPath(): a pending milvus.dbPath override lives
  // in this very file, so the file may never move with dbPath, or loading
  // it would be chicken-and-egg on exactly that knob. vaults.json keeps its
  // dbPath-derived location. This is the file's one anchor derivation.
  private settingsDirPath(): string {
    return stateDir(this.homedir())
  }

  private settingsFilePath(): string {
    return join(this.settingsDirPath(), SETTINGS_FILE_NAME)
  }

  // The VaultFs view of the service seam for core's provisioning helpers.
  private vaultFs(): VaultFs {
    return {
      exists: (path) => this.fs.exists(path),
      realpath: (path) => this.fs.realpath(path),
      mkdirp: (path) => { this.fs.mkdirp(path) },
      readFile: (path) => this.fs.readFile(path),
      writeFile: (path, contents) => { this.fs.writeFile(path, contents) },
    }
  }

  private canonicalize(path: string): string {
    return this.fs.exists(path) ? this.fs.realpath(path) : path
  }

  private duplicateVaultMessage(existing: VaultEntry, mode: VaultMode): string {
    const owner = existing.source === 'settings'
      ? 'the obsidian-mem-service row config.vaults (manage it there)'
      : existing.source === 'default'
        ? 'lazy provisioning (it is the default memory vault)'
        : 'the Obsidian Mem settings card'
    return `obsidian-mem addVault: ${existing.path} is already registered as `
      + `${existing.mode === mode ? 'the same mode by ' : `mode ${existing.mode} by `}${owner}`
  }

  private getEmbedder(): Embedder {
    this.embedderStore ??= createEmbedder({
      modelId: this.config.model.id,
      vectorDim: this.config.vectorDim,
      dtype: this.config.model.dtype,
      // resolveServiceConfig already fills the default; the '' check keeps a
      // hand-built resolved config from handing transformers.js an empty
      // env.cacheDir (createEmbedder would pass it through verbatim).
      cacheDir: this.config.model.cacheDir === ''
        ? modelCacheDir(this.homedir())
        : this.config.model.cacheDir,
    })
    return this.embedderStore
  }

  private buildIndexer(): IndexerLike {
    const options: ConstructorParameters<typeof IndexerManager>[0] = {
      vaults: this.listVaults(),
      embedder: this.getEmbedder(),
      // Cast to the indexer's narrow write slice; see the search() casts.
      writer: this.client as unknown as IndexWriter,
      ...(this.config.llm.enabled
        ? {
          llm: {
            enabled: true,
            baseUrl: this.config.llm.baseUrl,
            model: this.config.llm.model,
            ...(this.config.llm.apiKeyEnv === '' ? {} : { apiKeyEnv: this.config.llm.apiKeyEnv }),
          },
        }
        : {}),
      log: (message) => { this.log.debug(`[indexer] ${message}`) },
    }
    if (this.indexerFactory !== null) {
      return this.indexerFactory(options)
    }
    return new IndexerManager(options)
  }

  // Re-form the manager after a vault add/remove so the new registry is
  // watched/indexed without a restart. Cheap: watchers close, indexers
  // re-diff their state files (no re-embed for unchanged files).
  private restartIndexer(): void {
    if (this.indexer === null || this.client === null) {
      return
    }
    const previous = this.indexer
    previous.stop()
    this.indexer = this.buildIndexer()
    this.indexer.start()
  }

  // Drop each vault's indexer state file (and stale tmp) so the next run
  // treats every file as new: the forced full reindex after a collection
  // rebuild. Best-effort per vault; a missing file is the empty answer.
  private dropVaultStateFiles(): void {
    for (const vault of this.listVaults()) {
      for (const suffix of ['', STATE_FILE_TMP_SUFFIX]) {
        const statePath = `${indexStatePath(vault.path)}${suffix}`
        try {
          if (this.fs.exists(statePath)) {
            this.fs.unlink(statePath)
          }
        } catch (error: unknown) {
          this.log.warn(`state reset skipped for ${statePath}: ${describeError(error)}`)
        }
      }
    }
  }

  // Delete the vault's rows in the collection (TASK-030 removeVault). The
  // stored `vault` column is the path truncated to the column width, so
  // the filter uses the same truncation.
  private async dropVaultChunks(path: string): Promise<void> {
    const client = this.client
    if (client === null) {
      return
    }
    try {
      await client.delete({
        collection_name: MILVUS_COLLECTION,
        filter: `${MILVUS_FIELDS.vault} == ${quoteExpr(vaultKey(path))}`,
      })
    } catch (error: unknown) {
      this.log.warn(`chunk delete failed for vault ${path}: ${describeError(error)}`)
    }
  }

  // Registry lookup for the search result `vault` column value.
  private modeForVaultValue(value: string): VaultMode | undefined {
    return this.listVaults().find((entry) => vaultKey(entry.path) === value)?.mode
  }

  private registerTeardown(): void {
    if (this.teardownRegistered) return
    this.teardownRegistered = true
    this.ctx.effect(() => () => this.stop(), `${OBSIDIAN_MEM_SEAM}.effects`)
  }

  private async teardown(): Promise<void> {
    this.indexer?.stop()
    const launcher = this.launcher
    this.launcher = null
    if (launcher !== null) {
      try {
        await launcher.dispose()
      } catch (error: unknown) {
        this.log.warn(`milvus launcher dispose failed: ${describeError(error)}`)
      }
    }
    const client = this.client
    this.client = null
    if (client !== null) {
      try {
        await client.closeConnection()
      } catch (error: unknown) {
        this.log.warn(`milvus client close failed: ${describeError(error)}`)
      }
    }
  }
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
export function withObsidianMemHooks(hooks: ObsidianMemHooks): typeof ObsidianMemService {
  return class extends ObsidianMemService {
    constructor(ctx: Context, config: ObsidianMemConfig = {}) {
      super(ctx, config, hooks)
    }
  }
}

/** DefaultUvxPrewarm warms the uv cache for the pinned milvus-lite wheel. */
function defaultUvxPrewarm(command: string, args: readonly string[]): void {
  // Detached from any lifecycle: if uvx is absent or fails, the launcher's
  // own ensureUvx path is unchanged; this only shaves the first-start wait.
  const child = spawn(command, [...args], { stdio: 'ignore', detached: false })
  child.on('error', () => {
    // no uvx yet; nothing warmed
  })
  child.unref()
}

// Expr literal quoting, matching search.ts's filter escaping.
function quoteExpr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
