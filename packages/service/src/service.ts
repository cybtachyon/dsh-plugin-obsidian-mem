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
  firstSharedVault,
  formatLocalDate,
  isReservedNonIndexed,
  isVaultMode,
  markdownDir,
  metadataDir,
  MILVUS_COLLECTION,
  MILVUS_FIELDS,
  modelCacheDir,
  parseNote,
  provisionDefaultVault,
  resolveVaults,
  seedIntentsFile,
  serializeNoteWithRaw,
  validateMeta,
} from '../../core/lib/index.js'
import type {
  FsProbe,
  NoteMeta,
  VaultConfig,
  VaultFs,
  VaultMode,
} from '../../core/lib/index.js'
import {
  expandHomePath,
  ObsidianMemConfigSchema,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
  vaultKey,
} from './config.js'
import type { ObsidianMemConfig, ResolvedObsidianMemConfig } from './config.js'
import { inventoryVault, nodeAuditFs, runStoreAudit } from './audit.js'
import type { AuditFs, AuditReport, AuditRequest, CollectionProbeResult, VaultInventory } from './audit.js'
import { DreamOrchestrator } from './dream.js'
import type { DreamAgentsGateway, DreamEngineResult, DreamRequest, DreamRunSummary, DreamVectorTarget } from './dream.js'
import { createEmbedder } from './embedder.js'
import type { Embedder } from './embedder.js'
import { describeError } from './errors.js'
import { IndexerManager, STATE_FILE_NAME } from './indexer.js'
import type { IndexProgress, IndexWriter } from './indexer.js'
import { readyMilvusClient } from './milvus/client.js'
import { MILVUS_LITE_VERSION, MilvusLauncher } from './milvus/launcher.js'
import type { MilvusLauncherOptions, MilvusStartResult } from './milvus/launcher.js'
import { assertOk } from './milvus/ok.js'
import { ensureCollection, rebuildCollection, storedDenseDim } from './milvus/schema.js'
import { hybridSearch, IndexOfflineError } from './search.js'
import type { MemorySearchResult, SearchDependencies, SearchRequest } from './search.js'

/** Seam name this service publishes; the patch rows inject this name. */
export const OBSIDIAN_MEM_SEAM = 'obsidianMem'

/** File holding the card-managed vault additions under the state dir. */
export const VAULTS_FILE_NAME = 'vaults.json'

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
  /** Path relative to the vault root, e.g. `markdown/topic.md`. */
  relPath: string
}

/** Placeholder shape for the global per-session recall budget (TASK-045). */
export interface GlobalMemoryIndex {
  budgetTokens: number
  usedTokens: number
  remainingTokens: number
}

/**
 * SessionRegistryView is the minimal read slice the service needs of the
 * per-session memory registry (TASK-040 seam). The events package owns and
 * constructs the registry instance; the service only holds the wired
 * reference, so the package dependency stays events → service, never back.
 * TASK-045 reads recall usage through it inside globalMemoryIndex.
 */
export interface SessionRegistryView {
  /** Sums the recall tokens injected across every session the registry knows. */
  totalRecallTokensUsed(): number
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
  vaults: { path: string; mode: string }[]
}

// One registry generation: resolved vaults plus who registered each path.
interface VaultRegistryView {
  vaults: VaultEntry[]
}

/**
 * ObsidianMemService is `ctx.obsidianMem`. Construction resolves config
 * (schema defaults applied, `~` expanded) and touches nothing on disk;
 * `ensureMemoryAccess()` runs the one-time provisioning pass; every
 * memory-facing method (read, write, search, addVault persistence) routes
 * through it or owns its explicit disk effect.
 */
export class ObsidianMemService extends Service {
  /** The plugin config schema every mounted row validates against. */
  static Config: NonNullable<Plugin.Base<ResolvedObsidianMemConfig>['Config']> = ObsidianMemConfigSchema

  /** The resolved config: schema defaults plus home-expanded paths. */
  readonly config: ResolvedObsidianMemConfig

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
  private indexer: IndexerLike | null = null
  private teardownRegistered = false
  private teardownPromise: Promise<void> | null = null

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
    this.config = resolveServiceConfig(resolved, this.homedir())
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
   * AddVault registers a card-side vault: `shared` paths are created
   * (root + markdown/ + metadata/), `read-only` paths must already exist,
   * duplicates are refused with the current registration named, and
   * settings-managed paths cannot be shadowed. New card vaults persist to
   * <stateDir>/vaults.json atomically.
   */
  addVault(request: VaultAddRequest): VaultEntry {
    const mode = request.mode ?? 'shared'
    if (!isVaultMode(mode)) {
      throw new Error(`obsidian-mem addVault: mode must be one of shared | read-only, got "${mode}"`)
    }
    const rawPath = expandHomePath(request.path, this.homedir())
    const registry = this.loadRegistry()

    if (mode === 'shared') {
      this.fs.mkdirp(rawPath)
      this.fs.mkdirp(markdownDir(rawPath))
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

    const entry: VaultEntry = { path: canonical, mode, source: 'card' }
    registry.vaults.push(entry)
    this.persistVaultsFile()
    this.restartIndexer()
    return { ...entry }
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

    registry.vaults.splice(index, 1)
    this.persistVaultsFile()
    for (const readPath of [...this.readRegistry.keys()]) {
      if (readPath.startsWith(`${target}/`) || readPath.startsWith(`${target}\\`)) {
        this.readRegistry.delete(readPath)
      }
    }
    await this.dropVaultChunks(entry.path)
    this.restartIndexer()
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
    if (classified.mode === 'shared') {
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
    if (classified.mode !== 'shared') {
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
    if (!classified.insideMarkdownDir) {
      throw new Error(
        `obsidian-mem write: ${target} is outside the indexed markdown/ dir of vault ${classified.vault.path}`,
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
    const client = this.client
    if (client === null) {
      throw new IndexOfflineError(
        `memory index is offline${this.milvusError === null ? '' : `: ${this.milvusError}`}`,
      )
    }
    if (this.launcher?.degraded === true) {
      throw new IndexOfflineError('milvus child died; a respawn is pending, retry shortly')
    }
    return await hybridSearch({
      // Structural casts of the whole client to the narrow slices search
      // and the indexer declare: the SDK's overloaded method unions do not
      // line up with the plain shapes under exactOptionalPropertyTypes,
      // while the dispatched request shapes are the verified ones
      // (milvus-live.spec, search.spec, indexer.spec).
      client: client as unknown as SearchDependencies['client'],
      embedder: this.getEmbedder(),
      vaultModeFor: (vault) => this.modeForVaultValue(vault),
      defaultTokenCap: this.config.budgets.readSectionTokens,
    }, request)
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
   * GlobalMemoryIndex is the global per-session recall-budget shape
   * (TASK-045): the placeholder reports the configured budget with zero
   * usage; TASK-045 owns the real accounting, reading the wired
   * {@link ObsidianMemService.sessionRegistry} for per-session use.
   * TODO-045: replace the empty implementation with the session budget index.
   */
  globalMemoryIndex(): GlobalMemoryIndex {
    const budgetTokens = this.config.budgets.globalMemoryTokens
    return { budgetTokens, usedTokens: 0, remainingTokens: budgetTokens }
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
        noteVectors: (targets) => this.fetchNoteVectors(targets),
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
  private readVaultsFile(): { path: string; mode: string }[] {
    const raw = this.fs.readFile(this.vaultsFilePath())
    if (raw === null) return []
    try {
      const parsed = JSON.parse(raw) as Partial<VaultFileRecord>
      return Array.isArray(parsed.vaults)
        ? parsed.vaults.filter((v): v is { path: string; mode: string } => (
          typeof v?.path === 'string' && typeof v?.mode === 'string'
        ))
        : []
    } catch (error: unknown) {
      this.log.warn(`vaults.json unreadable (${this.vaultsFilePath()}): ${describeError(error)}; starting empty`)
      return []
    }
  }

  private persistVaultsFile(): void {
    const registry = this.loadRegistry()
    const record: VaultFileRecord = {
      version: 1,
      vaults: registry.vaults
        .filter((entry) => entry.source === 'card')
        .map((entry) => ({ path: entry.path, mode: entry.mode })),
    }
    this.fs.mkdirp(this.stateDirPath())
    this.writeAtomic(this.vaultsFilePath(), `${JSON.stringify(record, null, 2)}\n`)
  }

  private writeAtomic(path: string, contents: string): void {
    const tmp = `${path}.obsidian-mem.tmp`
    this.fs.writeFile(tmp, contents)
    this.fs.rename(tmp, path)
  }

  // <dbPath>/state mirrors core's stateDir(homedir) = dbDir/state for the
  // default dbPath, and follows a custom dbPath otherwise.
  private stateDirPath(): string {
    return join(this.config.milvus.dbPath, 'state')
  }

  private vaultsFilePath(): string {
    return join(this.stateDirPath(), VAULTS_FILE_NAME)
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
      cacheDir: modelCacheDir(this.homedir()),
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
      for (const suffix of ['', '.tmp']) {
        const statePath = `${join(metadataDir(vault.path), STATE_FILE_NAME)}${suffix}`
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
