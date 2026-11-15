import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import {
  DREAM_NEAR_DUPLICATE_THRESHOLD,
  DEFAULT_CHURN_THRESHOLD_PERCENT,
  DEFAULT_CHURN_WINDOW_COMMITS,
  GLOBAL_MEMORY_FILE_DEFAULT,
  GLOBAL_MEMORY_TOKENS,
  INTENTS_FILE,
  VECTOR_DIM_DEFAULT,
  dbDir,
  defaultVaultPath,
  metadataDir,
  modelCacheDir,
  parseNote,
  serializeNoteWithRaw,
  stateDir,
} from '../../core/lib/index.js'
import type { GitRunner, NoteMeta } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import type { Embedder } from '../src/embedder.ts'
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  ObsidianMemConfigSchema,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
} from '../src/config.ts'
import type {
  MountedVaultEntry,
  ObsidianMemConfig,
  ObsidianMemConfigValidation,
  ResolvedObsidianMemConfig,
} from '../src/config.ts'
import { ObsidianMemService, TEARDOWN_FLUSH_TIMEOUT_MS } from '../src/service.ts'
import type {
  IndexerLike,
  MilvusLauncherLike,
  ObsidianMemHooks,
  ServiceFs,
} from '../src/service.ts'
import type { MilvusLauncherOptions, MilvusStartResult } from '../src/milvus/launcher.ts'
import type { IndexerManagerOptions } from '../src/indexer.ts'
import { createdEntry, fakeGateway } from './dream-testkit.ts'

/** validValue unwraps a successful validation, throwing on issues. */
function validValue(result: ObsidianMemConfigValidation): ResolvedObsidianMemConfig {
  if (!('value' in result)) {
    throw new Error(`unexpected config issues: ${JSON.stringify(result.issues)}`)
  }
  return result.value
}

/**
 * Service seam tests for TASK-030, mocked at every external seam (fs,
 * launcher, client, embedder, indexer manager, pre-warm) on a hand-built
 * fake ctx: activation creates nothing; ensureMemoryAccess provisions
 * exactly once (including two concurrent calls) and yields the one-time
 * notice exactly once; the vault registry persists card additions
 * atomically and protects settings/default vaults; reads bump frontmatter
 * stats and fill the read registry; applyWrite merges un-modelled
 * frontmatter back before serializing; a failed milvus start degrades
 * (status reports, search throws IndexOfflineError) and never crashes;
 * the TASK-003 cold split gates applyWrite on core provisioning alone while
 * search and ensureMemoryAccess keep awaiting the settled index stack;
 * teardown drains the write follow-ups bounded by
 * {@link TEARDOWN_FLUSH_TIMEOUT_MS}, then stops the indexer, kills the
 * child, and closes the client.
 */

// ---------------------------------------------------------------------------
// MemFs: in-memory ServiceFs recording every mutating call.

class MemFs implements ServiceFs {
  readonly files = new Map<string, { content: string; mtimeMs: number }>()
  readonly dirs = new Set<string>()
  readonly mutations: string[] = []
  private clock = 1000

  seedDir(path: string): void {
    this.dirs.add(path)
  }

  seedFile(path: string, content: string): void {
    this.files.set(path, { content, mtimeMs: ++this.clock })
    this.dirs.add(path.slice(0, path.lastIndexOf('/')))
  }

  has(path: string): boolean {
    return this.files.has(path)
  }

  content(path: string): string | undefined {
    return this.files.get(path)?.content
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  realpath(path: string): string {
    return path
  }

  mkdirp(path: string): void {
    this.mutations.push(`mkdirp ${path}`)
    this.dirs.add(path)
  }

  readFile(path: string): string | null {
    return this.files.get(path)?.content ?? null
  }

  writeFile(path: string, contents: string): void {
    this.mutations.push(`writeFile ${path}`)
    this.files.set(path, { content: contents, mtimeMs: ++this.clock })
  }

  rename(from: string, to: string): void {
    this.mutations.push(`rename ${from} -> ${to}`)
    const file = this.files.get(from)
    this.files.delete(from)
    if (file !== undefined) {
      this.files.set(to, file)
    }
  }

  unlink(path: string): void {
    this.mutations.push(`unlink ${path}`)
    this.files.delete(path)
  }

  stat(path: string): { mtimeMs: number } | null {
    const file = this.files.get(path)
    return file === undefined ? null : { mtimeMs: file.mtimeMs }
  }
}

// ---------------------------------------------------------------------------
// Fake ctx: just the surface the Service base class and the seam consume.

function fakeCtx(services: Record<string, unknown> = {}) {
  const provided = new Map<string, unknown>()
  const warnings: string[] = []
  const errors: string[] = []
  const effects: Array<{ label: string; dispose: () => unknown }> = []
  const ctx = {
    reflect: {
      provide: (name: string, value: unknown) => {
        provided.set(name, value)
        return () => { provided.delete(name) }
      },
    },
    logger: () => ({
      info: () => {},
      warn: (message: unknown) => { warnings.push(String(message)) },
      error: (message: unknown) => { errors.push(String(message)) },
      debug: () => {},
    }),
    effect: (execute: () => () => unknown, label: string) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => { dispose() }
    },
    // Host ctx.get answers undefined for a service that is not mounted.
    get: (name: string) => services[name],
  }
  return { ctx: ctx as unknown as Context, provided, warnings, errors, effects }
}

// ---------------------------------------------------------------------------
// Stub launcher / client / indexer, built fresh per harness.

interface StubLauncher extends MilvusLauncherLike {
  start: Mock<() => Promise<MilvusStartResult>>
  dispose: Mock<() => Promise<void>>
  factoryOptions: MilvusLauncherOptions[]
  setDegraded(value: boolean): void
}

function stubLauncher(failMessage?: string): StubLauncher {
  const factoryOptions: MilvusLauncherOptions[] = []
  const launcher = {
    degraded: false,
    address: '127.0.0.1:19530',
    factoryOptions,
    start: vi.fn(async (): Promise<MilvusStartResult> => {
      if (failMessage !== undefined) {
        throw new Error(failMessage)
      }
      return { address: '127.0.0.1:19530', version: 'milvus_lite-3.2.2', spawned: true }
    }),
    dispose: vi.fn(async () => {}),
    setDegraded(value: boolean) {
      launcher.degraded = value
    },
  }
  return launcher as unknown as StubLauncher
}

function stubClient(options: { existingDim?: number | null | undefined } = {}) {
  const calls: string[] = []
  const deletes: Array<Record<string, unknown>> = []
  const ok = { status: { error_code: 'Success', code: 0, reason: '' } }
  // Mirrors the dropCollection → recreate transition so a rebuild pass
  // sees the collection absent on the post-drop hasCollection.
  let dim: number | null | undefined = options.existingDim
  return {
    calls,
    deletes,
    async hasCollection() {
      calls.push('hasCollection')
      return { ...ok, value: dim !== undefined && dim !== null }
    },
    async describeCollection() {
      calls.push('describeCollection')
      return {
        ...ok,
        collection_name: 'obsidian_mem',
        schema: {
          fields: [
            // The core MILVUS_FIELDS names (dense_vector, sparse): the dim
            // and sparse-membership checks read them, so an existingDim
            // must describe as a schema that actually matches.
            { name: 'dense_vector', type: 'FloatVector', dim },
            { name: 'sparse', type: 'SparseFloatVector' },
          ],
        },
      }
    },
    async createCollection(request: Record<string, unknown>) {
      calls.push('createCollection')
      // Record the created dim like the real server so the next
      // hasCollection reports the collection as existing.
      const fields = (request['fields'] ?? []) as Array<{ name: string; params?: { dim?: number } }>
      dim = fields.find((field) => field.name === 'dense_vector')?.params?.dim ?? VECTOR_DIM_DEFAULT
      return ok
    },
    async createIndex() { calls.push('createIndex'); return ok },
    async loadCollectionSync() { calls.push('loadCollectionSync'); return ok },
    async dropCollection() { calls.push('dropCollection'); dim = null; return ok },
    async delete(request: Record<string, unknown>) { calls.push('delete'); deletes.push(request); return ok },
    async count() { calls.push('count'); return { ...ok, data: 1 } },
    async search(request: Record<string, unknown>) {
      calls.push('search')
      // Route-aware row: the dense route (MILVUS_FIELDS.denseVector, what
      // search.ts sends as anns_field) gets a within-radius score, the
      // sparse route a negated-relevance score past the client-side floor.
      // One row surviving BOTH routes at rank 1 fuses to 2/61, the shape
      // the TASK-009 fallback agreement floor keeps.
      const dense = request['anns_field'] === 'dense_vector'
      return {
        ...ok,
        results: [{
          chunk_id: 7,
          source_path: 'topic.md',
          section_header: 'Topic',
          chunk_text: 'the fact, stated plainly',
          scope: 'global',
          vault: '/home/test/.dsh/obsidian-mem',
          updated_at: 1700000000000,
          score: dense ? 0.91 : -6.0,
        }],
      }
    },
    closeConnection: vi.fn(async () => {}),
  }
}

interface StubIndexer extends IndexerLike {
  start: Mock<() => void>
  stop: Mock<() => void>
  indexFile: Mock<(vaultPath: string, relPath: string) => Promise<boolean>>
  reindexAll: Mock<() => Promise<void>>
  builtWithOptions: IndexerManagerOptions[]
}

function stubIndexer(): StubIndexer {
  const builtWithOptions: IndexerManagerOptions[] = []
  return {
    builtWithOptions,
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    reindexAll: vi.fn<() => Promise<void>>(async () => {}),
    indexFile: vi.fn<(vaultPath: string, relPath: string) => Promise<boolean>>(async () => true),
    progress: () => ({ indexed: 3, pending: 0, errors: 0, llmErrors: 0 }),
  }
}

// ---------------------------------------------------------------------------
// Harness.

const HOME = '/home/test'
const DB_PATH = dbDir(HOME)
const VAULTS_JSON = join(stateDir(HOME), 'vaults.json')
const DEFAULT_VAULT = defaultVaultPath(HOME)

// SLOW_CHAIN_MS is the slow fake chain's latency and the ceiling the write
// that fired it must beat to prove it never awaited the chain.
const SLOW_CHAIN_MS = 250

// TEARDOWN_MARGIN_MS is the wall-clock ceiling on a teardown whose follow-up
// chain is wedged: it proves teardown only waited for the cap timer (or
// nothing), never for the chain. Virtual timers make the cap itself instant.
const TEARDOWN_MARGIN_MS = 5_000

interface HarnessOptions {
  config?: ObsidianMemConfig
  seedFiles?: Record<string, string>
  seedDirs?: string[]
  milvusFail?: string
  existingDim?: number | null
  /** Fail the first mkdirp call hard (a non-milvus provisioning failure). */
  failFirstMkdirp?: boolean
  /** Host services the fake ctx.get answers for (agents, agentDefaultModel). */
  services?: Record<string, unknown>
  /** Omit the embedder seam so getEmbedder builds real (lazy) embedders. */
  noEmbedderSeam?: boolean
  /** Turn the git group on for the vault-git wiring describe (TASK-004). */
  gitEnabled?: boolean
  /** git process boundary for the vault-git wiring describe. */
  gitRunner?: (root: string) => GitRunner
}

// The big harness runs with git OFF: provisioning-time adoption would
// otherwise git-init the MemFs-only vault roots against the real disk
// (MemoryGit writes its .gitignore through node:fs). Git wiring gets its
// own describe with gitEnabled plus real temp-dir roots. An injected inert
// all-clean runner is the hermeticity belt: no case in this file can ever
// fork the git binary.
const INERT_GIT_RUNNER = (root: string): GitRunner => {
  void root
  return async () => ({ code: 0, stdout: '', stderr: '' })
}

/** NeverSettling answers a promise that never settles: a wedged chain fixture. */
function neverSettling<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function harness(options: HarnessOptions = {}) {
  const fs = new MemFs()
  if (options.failFirstMkdirp === true) {
    const real = fs.mkdirp.bind(fs)
    let armed = true
    fs.mkdirp = (path: string) => {
      if (armed) {
        armed = false
        throw new Error(`disk error mkdir ${path}`)
      }
      real(path)
    }
  }
  for (const dir of options.seedDirs ?? []) {
    fs.seedDir(dir)
  }
  for (const [path, content] of Object.entries(options.seedFiles ?? {})) {
    fs.seedFile(path, content)
  }
  const config: ObsidianMemConfig = {
    ...options.config,
    git: options.gitEnabled === true
      ? { enabled: true }
      : options.config?.git ?? { enabled: false },
  }
  const ctx = fakeCtx(options.services ?? {})
  const launcher = stubLauncher(options.milvusFail)
  const client = stubClient({ existingDim: options.existingDim })
  const indexer = stubIndexer()
  const prewarm = vi.fn()
  const order: string[] = []
  const hooks: ObsidianMemHooks = {
    homedir: () => HOME,
    fs,
    launcherFactory: (factoryOptions) => {
      order.push('launcherFactory')
      launcher.factoryOptions.push(factoryOptions)
      return launcher
    },
    clientFactory: async (address) => {
      order.push(`client:${address}`)
      return client as never
    },
    ...(options.noEmbedderSeam === true
      ? {}
      : { embedder: fakeEmbedder({ vectorDim: options.config?.vectorDim ?? VECTOR_DIM_DEFAULT }) }),
    indexerFactory: (managerOptions) => {
      indexer.builtWithOptions.push(managerOptions)
      return indexer
    },
    prewarm,
    gitRunner: options.gitRunner ?? INERT_GIT_RUNNER,
  }
  const service = new ObsidianMemService(ctx.ctx, config, hooks)
  return { fs, ctx, launcher, client, indexer, prewarm, order, service }
}

function testMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    index_title: 'Topic: scenario',
    index_description: 'what this note decides',
    type: 'global',
    archive: false,
    created: '2026-11-01',
    updated: '2026-11-01',
    read_count: 0,
    ...overrides,
  }
}

/** GitRecorderOptions scripts the two git failure modes a write must survive. */
interface GitRecorderOptions {
  adoptionFails?: boolean
  commitFails?: boolean
}

/**
 * RecordingGit answers like a healthy adopted repo and logs every call's
 * root. markDirty scripts the change a write lands for the next status
 * probe (a clean tree is what commitAll answers null on); a recorded
 * commit cleans the tree again like real git; commitFails scripts git
 * refusing the commit itself.
 */
function recordingGit(options: GitRecorderOptions = {}) {
  const calls: Array<{ root: string; argv: string[] }> = []
  let dirty = false
  const gitRunner = (root: string): GitRunner => async (argv) => {
    calls.push({ root, argv })
    if (options.adoptionFails === true) {
      return { code: 128, stdout: '', stderr: 'fatal: fake adoption failure' }
    }
    if (argv.includes('status')) {
      return { code: 0, stdout: dirty ? '?? pending.md\n' : '', stderr: '' }
    }
    if (argv.includes('commit')) {
      if (options.commitFails === true) {
        return { code: 1, stdout: '', stderr: 'fatal: fake commit failure' }
      }
      dirty = false
      return { code: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
      return { code: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return {
    calls,
    gitRunner,
    /** MarkDirty scripts a working-tree change for the next status probe. */
    markDirty(): void {
      dirty = true
    },
  }
}

/** CommitMessages lists the -m message of every recorded `commit` call. */
function commitMessages(git: ReturnType<typeof recordingGit>): Array<string | undefined> {
  return git.calls
    .filter((call) => call.argv.includes('commit'))
    .map((call) => call.argv[call.argv.indexOf('-m') + 1])
}

/** GitWriteHarness: a git-enabled service over one fresh real temp-dir shared vault, with its path. */
function gitWriteHarness(git: ReturnType<typeof recordingGit>) {
  const vault = gitTempDir()
  return { vault, ...gitVaultHarness(git, [{ path: vault }]) }
}

/**
 * WriteReadyGitHarness answers a git service over a fresh adopted vault after
 * provisioning, with the adoption calls cleared and a dirty working tree
 * scripted: the next write's commit is the only git activity a test sees.
 */
async function writeReadyGitHarness(options: GitRecorderOptions = {}) {
  const git = recordingGit(options)
  const h = gitWriteHarness(git)
  await h.service.ensureMemoryAccess()
  git.calls.length = 0
  git.markDirty()
  return { git, h }
}

/** GitVaultHarness: a git-enabled harness over given real temp-dir vault roots. */
function gitVaultHarness(
  git: { gitRunner: (root: string) => GitRunner },
  vaults: MountedVaultEntry[],
) {
  return harness({
    gitEnabled: true,
    seedDirs: vaults.map((vault) => vault.path),
    config: { vaults },
    gitRunner: git.gitRunner,
  })
}

// Temp vault roots behind the git-enabled services: MemoryGit writes its
// .gitignore through node:fs, so these cases need real directories. The
// module afterEach removes whatever the running test created.
const gitTempDirs: string[] = []

/** GitTempDir answers a fresh real directory registered for afterEach cleanup. */
function gitTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-mem-svc-git-'))
  gitTempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of gitTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('config schema', () => {
  const fullDefaults = {
    vaults: [],
    vectorDim: 384,
    model: { id: 'Xenova/multilingual-e5-small', dtype: 'q8', cacheDir: '' },
    milvus: { mode: 'spawn', address: '', dbPath: '', readinessTimeoutMs: 600_000 },
    budgets: {
      turnStartRecallTokens: 1200,
      globalMemoryTokens: 1500,
      readSections: 2,
      readSectionTokens: 350,
      searchTopK: 6,
      thinkShotsPerTurn: 3,
    },
    llm: { enabled: false, baseUrl: '', model: '', apiKeyEnv: '' },
    dreaming: { schedules: [], model: '', nearDuplicateThreshold: DREAM_NEAR_DUPLICATE_THRESHOLD },
    git: {
      enabled: true,
      churnThresholdPercent: DEFAULT_CHURN_THRESHOLD_PERCENT,
      churnWindowCommits: DEFAULT_CHURN_WINDOW_COMMITS,
    },
  }

  it('resolves {} (and undefined) to the complete default config', () => {
    expect(validValue(validateObsidianMemConfig({}))).toEqual(fullDefaults)
    expect(validValue(validateObsidianMemConfig(undefined))).toEqual(fullDefaults)
  })

  it('carries unknown keys onto a symbol, never into the resolved value', () => {
    const value = validValue(validateObsidianMemConfig({ bogus: 1, milvus: { mode: 'spawn', extra: 2 } })) as
      ResolvedObsidianMemConfig & { [UNKNOWN_CONFIG_KEYS]?: string[] }
    expect(value).not.toHaveProperty('bogus')
    expect(value.milvus).not.toHaveProperty('extra')
    expect(value[UNKNOWN_CONFIG_KEYS]).toEqual(['bogus', 'milvus.extra'])
  })

  it('warns (does not throw) on unknown keys through the plugin logger', () => {
    const { ctx, warnings } = fakeCtx()
    const service = new ObsidianMemService(ctx, { nope: true } as ObsidianMemConfig)
    expect(warnings.join('\n')).toContain('nope')
    expect(service.config.vaults).toEqual([])
  })

  it('accepts the vectorDim enum and rejects off-enum widths', () => {
    expect(validValue(validateObsidianMemConfig({ vectorDim: 256 })).vectorDim).toBe(256)
    expect(validateObsidianMemConfig({ vectorDim: 999 }).issues?.[0]?.message)
      .toMatch(/384 \(full width\).*128\/192\/256\/320/)
  })

  it('resolves model.cacheDir at construction: core default, custom expanded, sentinel default', () => {
    expect(harness().service.config.model.cacheDir).toBe(modelCacheDir(HOME))

    const sentinel = harness({ config: { model: { cacheDir: '' } } })
    expect(sentinel.service.config.model.cacheDir).toBe(modelCacheDir(HOME))

    const custom = harness({ config: { model: { cacheDir: '~/mm' } } })
    expect(custom.service.config.model.cacheDir).toBe(join(HOME, 'mm'))
  })

  it('getEmbedder keeps an empty hand-built model.cacheDir out of createEmbedder', () => {
    const { service } = harness()
    // resolveServiceConfig never leaves cacheDir '' (the resolve tests pin
    // it); this covers the getEmbedder guard for a config that bypassed
    // resolve, where '' would reach transformers.js env.cacheDir.
    service.config.model.cacheDir = ''
    const embedderHost = service as unknown as { getEmbedder(): Embedder }
    expect(() => embedderHost.getEmbedder()).not.toThrow()
  })

  it('defaults vault modes and globalFile and rejects bad ones with a path', () => {
    const ok = validateObsidianMemConfig({ vaults: [{ path: '/v' }] })
    expect(validValue(ok).vaults).toEqual([{ path: '/v', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT }])
    const bad = validateObsidianMemConfig({ vaults: [{ path: '/v', mode: 'rw' }] })
    expect(bad.issues?.[0]?.path).toEqual(['vaults', 0, 'mode'])
  })

  it('requires exactly one trigger per dreaming schedule', () => {
    const good = validateObsidianMemConfig({
      dreaming: { schedules: [
        { id: 'weekly', label: 'Weekly dream', expression: '0 3 * * 1' },
        { id: 'often', label: 'Often', everySeconds: 3600 },
      ] },
    })
    expect(validValue(good).dreaming.schedules).toHaveLength(2)
    const bad = validateObsidianMemConfig({
      dreaming: { schedules: [{ id: 'x', label: 'x' }] },
    })
    expect(bad.issues?.[0]?.message).toMatch(/exactly one of expression or everySeconds/)
  })

  it('exposes the same standard-schema through the static Config', async () => {
    expect(ObsidianMemService.Config['~standard'].vendor).toBe('obsidian-mem')
    expect((await ObsidianMemService.Config['~standard'].validate({})).issues).toBeUndefined()
    expect(ObsidianMemConfigSchema).toBe(ObsidianMemService.Config)
  })

  it('resolveServiceConfig expands ~ and defaults dbPath from core dbDir', () => {
    const resolved = validValue(validateObsidianMemConfig({
      vaults: [{ path: '~/notes' }, { path: '/abs' }],
    }))
    const final = resolveServiceConfig(resolved, HOME)
    expect(final.vaults.map((v) => v.path)).toEqual([`${HOME}/notes`, '/abs'])
    expect(final.milvus.dbPath).toBe(DB_PATH)
    const custom = resolveServiceConfig({
      ...resolved,
      milvus: { ...resolved.milvus, dbPath: '~/my-db' },
    }, HOME)
    expect(custom.milvus.dbPath).toBe(`${HOME}/my-db`)
  })

  it('keeps the readiness timeout default at the G13 budget', () => {
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBe(600_000)
    expect(validValue(validateObsidianMemConfig({})).milvus.readinessTimeoutMs).toBe(600_000)
  })
})

describe('activation is side-effect free', () => {
  it('creates nothing on disk with empty vaults, until first use', () => {
    const h = harness()
    // The constructor ran; touch the cheapest read-only entry points too.
    h.service.status()
    h.service.listVaults()
    expect(h.fs.mutations).toEqual([])
    expect(h.fs.files.size).toBe(0)
    expect(h.launcher.start).not.toHaveBeenCalled()
    expect(h.prewarm).not.toHaveBeenCalled()
  })
})

describe('ensureMemoryAccess', () => {
  it('provisions default vault, db, pre-warm, client-after-readiness, collection', async () => {
    const h = harness()
    const notice = await h.service.ensureMemoryAccess()
    expect(notice).toBe(
      `Obsidian Mem is using the default memory vault at ${DEFAULT_VAULT}. `
      + 'Add your own vaults in the Obsidian Mem settings card to override.',
    )
    // TASK-004 test adaptation: provisioning creates root + metadata only.
    expect(h.fs.dirs.has(DEFAULT_VAULT)).toBe(true)
    expect(h.fs.dirs.has(metadataDir(DEFAULT_VAULT))).toBe(true)
    // The .INTENTS.md seed lives at the vault root.
    expect(h.fs.files.has(join(DEFAULT_VAULT, INTENTS_FILE))).toBe(true)
    expect(h.fs.content(join(DEFAULT_VAULT, INTENTS_FILE))).toContain('## investigate')
    expect(h.fs.dirs.has(DB_PATH)).toBe(true)
    expect(h.prewarm).toHaveBeenCalledWith('uvx', [
      '--with', 'pymilvus', '--from', 'milvus-lite==3.2.2', 'milvus-lite', '--help',
    ])
    // G12: the long-lived client is created only after readiness answered.
    expect(h.order).toEqual(['launcherFactory', 'client:127.0.0.1:19530'])
    expect(h.launcher.factoryOptions[0]).toMatchObject({
      config: { mode: 'spawn', dataDir: DB_PATH },
      readinessTimeoutMs: 600_000,
    })
    expect(h.client.calls).toContain('createCollection')
    expect(h.client.calls).toContain('loadCollectionSync')
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
    expect(h.service.status().state).toBe('ready')
    // A second call never re-provisions and never re-notices.
    expect(await h.service.ensureMemoryAccess()).toBeUndefined()
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
  })

  it('passes configured readinessTimeoutMs to the launcher', async () => {
    const h = harness({ config: { milvus: { readinessTimeoutMs: 123456 } } })
    await h.service.ensureMemoryAccess()
    expect(h.launcher.factoryOptions[0]?.readinessTimeoutMs).toBe(123456)
  })

  it('concurrent calls converge on one pass and one notice', async () => {
    const h = harness()
    const [first, second] = await Promise.all([
      h.service.ensureMemoryAccess(),
      h.service.ensureMemoryAccess(),
    ])
    expect([first, second].filter((notice) => notice !== undefined)).toHaveLength(1)
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
  })

  it('degrades on a failed milvus start: status reports, no crash, notice still lands', async () => {
    const h = harness({ milvusFail: 'uvx missing and install failed' })
    const notice = await h.service.ensureMemoryAccess()
    expect(notice).toContain('default memory vault')
    const status = h.service.status()
    expect(status.state).toBe('degraded')
    expect(status.milvus.error).toContain('uvx missing')
    expect(h.client.calls).not.toContain('hasCollection')
    expect(h.service.listVaults().map((v) => v.path)).toContain(DEFAULT_VAULT)
  })

  it('hard provisioning failures reject and clear the flight for a retry', async () => {
    const h = harness({ failFirstMkdirp: true })
    await expect(h.service.ensureMemoryAccess()).rejects.toThrow(/disk error mkdir/)
    expect(h.service.status().state).toBe('inactive')
    const notice = await h.service.ensureMemoryAccess()
    expect(notice).toContain('default memory vault')
    expect(h.service.status().state).toBe('ready')
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
  })

  it('detects dim drift: rebuilds the collection and drops vault state files', async () => {
    const statePath = join(metadataDir('/vault'), 'obsidian-mem-state.json')
    const h = harness({
      config: { vaults: [{ path: '/vault', mode: 'shared' }] },
      seedDirs: ['/vault'],
      seedFiles: { [statePath]: '{"version":1,"modelId":"x","vectorDim":384,"files":{}}' },
      existingDim: 256,
    })
    await h.service.ensureMemoryAccess()
    expect(h.client.calls).toContain('dropCollection')
    expect(h.client.calls).toContain('createCollection')
    expect(h.fs.has(statePath)).toBe(false)
    expect(h.service.status().state).toBe('ready')
  })

  it('skips the uvx pre-warm in external mode', async () => {
    const h = harness({ config: { milvus: { mode: 'external', address: 'localhost:19530' } } })
    await h.service.ensureMemoryAccess()
    expect(h.prewarm).not.toHaveBeenCalled()
    expect(h.service.status().milvus.mode).toBe('external')
    expect(h.launcher.factoryOptions[0]?.config).toMatchObject({
      mode: 'external', address: 'localhost:19530',
    })
  })
})

describe('vault registry and vaults.json', () => {
  it('merges settings and card vaults, marking sources', () => {
    const h = harness({
      config: { vaults: [{ path: '/settings-vault', mode: 'shared' }] },
      seedDirs: ['/settings-vault', '/card-vault'],
      seedFiles: {
        [VAULTS_JSON]: JSON.stringify({ version: 1, vaults: [{ path: '/card-vault', mode: 'read-only' }] }),
      },
    })
    expect(h.service.listVaults()).toEqual([
      {
        path: '/settings-vault',
        mode: 'shared',
        globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
        source: 'settings',
      },
      {
        path: '/card-vault',
        mode: 'read-only',
        globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
        source: 'card',
      },
    ])
  })

  it('addVault creates a shared layout and persists card additions atomically', () => {
    const h = harness()
    const added = h.service.addVault({ path: '/data/notes', mode: 'shared' })
    expect(added).toEqual({
      path: '/data/notes',
      mode: 'shared',
      globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
      source: 'card',
    })
    expect(h.fs.dirs.has('/data/notes')).toBe(true)
    expect(h.fs.dirs.has(metadataDir('/data/notes'))).toBe(true)
    const persisted = JSON.parse(h.fs.content(VAULTS_JSON) ?? 'null')
    expect(persisted).toEqual({
      version: 1,
      vaults: [{ path: '/data/notes', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT }],
    })
    // Atomic: tmp write + rename, never a direct write of the final path.
    const fileMutations = h.fs.mutations.filter((m) => m.includes('vaults.json'))
    expect(fileMutations.some((m) => m.startsWith('writeFile') && m.includes('.tmp'))).toBe(true)
    expect(fileMutations.some((m) => m.startsWith('rename') && m.endsWith(`-> ${VAULTS_JSON}`))).toBe(true)
  })

  it('addVault requires existing paths for read-only and classifies duplicates', () => {
    const h = harness({
      config: { vaults: [{ path: '/settings-vault', mode: 'shared' }] },
      seedDirs: ['/settings-vault', '/ro', '/card'],
    })
    expect(() => h.service.addVault({ path: '/missing', mode: 'read-only' })).toThrow(/does not exist/)
    expect(() => h.service.addVault({ path: '/settings-vault' }))
      .toThrow(/already registered as the same mode by the obsidian-mem-service row config\.vaults/)
    h.service.addVault({ path: '/card', mode: 'read-only' })
    expect(() => h.service.addVault({ path: '/card', mode: 'shared' }))
      .toThrow(/already registered as mode read-only by the Obsidian Mem settings card/)
    expect(() => h.service.addVault({ path: '/card', mode: 'bogus' }))
      .toThrow(/mode must be one of shared \| read-only/)
  })

  it('addVault resolves globalFile: omitted, blank, and whitespace take the default', () => {
    const h = harness()
    expect(h.service.addVault({ path: '/a' }).globalFile).toBe(GLOBAL_MEMORY_FILE_DEFAULT)
    expect(h.service.addVault({ path: '/b', globalFile: '' }).globalFile).toBe(GLOBAL_MEMORY_FILE_DEFAULT)
    expect(h.service.addVault({ path: '/c', globalFile: '   ' }).globalFile).toBe(GLOBAL_MEMORY_FILE_DEFAULT)
    // An explicit value is trimmed and stored verbatim as the vault-root-relative path.
    expect(h.service.addVault({ path: '/d', globalFile: ' memory/GLOBAL.md ' }).globalFile)
      .toBe('memory/GLOBAL.md')
    const persisted = JSON.parse(h.fs.content(VAULTS_JSON) ?? 'null')
    expect(persisted.vaults.map((v: { globalFile: string }) => v.globalFile)).toEqual([
      GLOBAL_MEMORY_FILE_DEFAULT,
      GLOBAL_MEMORY_FILE_DEFAULT,
      GLOBAL_MEMORY_FILE_DEFAULT,
      'memory/GLOBAL.md',
    ])
  })

  it('addVault refuses absolute and parent-climbing globalFile before touching disk', () => {
    const h = harness()
    expect(() => h.service.addVault({ path: '/x', globalFile: '/GLOBAL.md' }))
      .toThrow(/globalFile must be vault-root-relative, not absolute/)
    expect(() => h.service.addVault({ path: '/y', globalFile: 'notes/../../GLOBAL.md' }))
      .toThrow(/globalFile must not contain a "\.\." segment/)
    // The refusal lands before provisioning: nothing was created, nothing registered.
    expect(h.fs.mutations).toEqual([])
    expect(h.service.listVaults()).toEqual([])
  })

  it('vaults.json round-trips globalFile and defaults entries stored without the key', () => {
    const h = harness({
      seedDirs: ['/card-a', '/card-b'],
      seedFiles: {
        [VAULTS_JSON]: JSON.stringify({ version: 1, vaults: [
          { path: '/card-a', mode: 'read-only', globalFile: 'NOTES/GLOBAL.md' },
          { path: '/card-b', mode: 'read-only' },
        ] }),
      },
    })
    // A pre-TASK-004 entry (no key) loads as the layout default.
    expect(h.service.listVaults().map((v) => [v.path, v.globalFile])).toEqual([
      ['/card-a', 'NOTES/GLOBAL.md'],
      ['/card-b', GLOBAL_MEMORY_FILE_DEFAULT],
    ])
    // Any rewrite persists the resolved value for every card entry.
    h.service.addVault({ path: '/card-c' })
    expect(JSON.parse(h.fs.content(VAULTS_JSON) ?? 'null')).toEqual({
      version: 1,
      vaults: [
        { path: '/card-a', mode: 'read-only', globalFile: 'NOTES/GLOBAL.md' },
        { path: '/card-b', mode: 'read-only', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
        { path: '/card-c', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      ],
    })
  })

  it('vaults.json loading drops a non-string globalFile so the core default wins', () => {
    const h = harness({
      seedDirs: ['/card-junk'],
      seedFiles: {
        [VAULTS_JSON]: JSON.stringify({ version: 1, vaults: [
          { path: '/card-junk', mode: 'read-only', globalFile: 42 },
        ] }),
      },
    })
    expect(h.service.listVaults().map((v) => v.globalFile)).toEqual([GLOBAL_MEMORY_FILE_DEFAULT])
  })

  it('settings-row vaults keep their configured globalFile through registry, status, and card payloads', () => {
    const h = harness({
      config: { vaults: [
        { path: '/settings-vault', mode: 'shared', globalFile: 'CORE/GLOBAL.md' },
        { path: '/plain-vault', mode: 'shared' },
      ] },
      seedDirs: ['/settings-vault', '/plain-vault'],
    })
    expect(h.service.listVaults()).toEqual([
      { path: '/settings-vault', mode: 'shared', globalFile: 'CORE/GLOBAL.md', source: 'settings' },
      { path: '/plain-vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT, source: 'settings' },
    ])
    // status() echoes the same entries, so the card rows read globalFile for free.
    expect(h.service.status().vaults).toEqual(h.service.listVaults())
  })

  it('removeVault protects settings and default vaults and drops card state', async () => {
    const h = harness({
      config: { vaults: [{ path: '/settings-vault', mode: 'shared' }] },
      seedDirs: ['/settings-vault', '/card'],
    })
    await h.service.ensureMemoryAccess()
    h.service.addVault({ path: '/card', mode: 'read-only' })
    h.client.deletes.length = 0

    await expect(h.service.removeVault('/settings-vault'))
      .rejects.toThrow(/managed by the obsidian-mem-service row config\.vaults/)

    await h.service.removeVault('/card')
    expect(h.service.listVaults().map((v) => v.path)).not.toContain('/card')
    expect(JSON.parse(h.fs.content(VAULTS_JSON) ?? '{}').vaults).toEqual([])
    expect(h.client.deletes[0]).toMatchObject({
      collection_name: 'obsidian_mem',
      filter: expect.stringContaining('/card'),
    })
  })

  it('removeVault refuses the auto-provisioned default vault', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    expect(h.service.listVaults().map((v) => v.source)).toContain('default')
    await expect(h.service.removeVault(DEFAULT_VAULT))
      .rejects.toThrow(/auto-provisioned default vault/)
  })

  it('addVault after provisioning re-forms the indexer over the new registry', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    expect(h.indexer.builtWithOptions).toHaveLength(1)
    h.service.addVault({ path: '/late', mode: 'shared' })
    expect(h.indexer.stop).toHaveBeenCalledTimes(1)
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(h.indexer.builtWithOptions[1]!.vaults.map((v) => v.path)).toContain('/late')
    expect(h.indexer.start).toHaveBeenCalledTimes(2)
  })

  it('survives a corrupt vaults.json as empty', () => {
    const h = harness({ seedFiles: { [VAULTS_JSON]: '{not json' } })
    expect(h.service.listVaults()).toEqual([])
    expect(h.ctx.warnings.join('\n')).toContain('vaults.json unreadable')
  })
})

// TASK-014: the read-only accessor behind turn-start pinned injection.
describe('globalMemorySources', () => {
  it('answers each shared vault global file raw in registry order, never provisioning', () => {
    const h = harness({
      config: { vaults: [
        { path: '/shared-a', mode: 'shared' },
        { path: '/shared-b', mode: 'shared', globalFile: 'memory/GLOBAL.md' },
        { path: '/ro', mode: 'read-only' },
      ] },
      seedDirs: ['/shared-a', '/shared-b', '/shared-b/memory', '/ro'],
      seedFiles: {
        '/shared-a/GLOBAL.md': '# A\nanchor facts\n',
        '/shared-b/memory/GLOBAL.md': '# B\nnested global\n',
        '/ro/GLOBAL.md': '# RO\nrecall-only vault content\n',
      },
    })
    // Registry order kept; the nested relative globalFile resolves under the
    // vault root; the read-only vault is excluded even with the file present.
    expect(h.service.globalMemorySources()).toEqual([
      { vaultPath: '/shared-a', path: '/shared-a/GLOBAL.md', content: '# A\nanchor facts\n' },
      { vaultPath: '/shared-b', path: '/shared-b/memory/GLOBAL.md', content: '# B\nnested global\n' },
    ])
    // A pure read: no provisioning, no launcher, no disk mutation, and the
    // read registry stays untouched (no stats bump; proven by no writes).
    expect(h.fs.mutations).toEqual([])
    expect(h.order).toEqual([])
    expect(h.launcher.start).not.toHaveBeenCalled()
  })

  it('skips a shared vault whose global file is missing and answers [] when none exist', () => {
    const h = harness({
      config: { vaults: [
        { path: '/shared-a', mode: 'shared' },
        { path: '/shared-b', mode: 'shared' },
      ] },
      seedDirs: ['/shared-a', '/shared-b'],
      seedFiles: { '/shared-b/GLOBAL.md': 'B global\n' },
    })
    expect(h.service.globalMemorySources()).toEqual([
      { vaultPath: '/shared-b', path: '/shared-b/GLOBAL.md', content: 'B global\n' },
    ])
    const onlyMissing = harness({
      config: { vaults: [{ path: '/shared-a', mode: 'shared' }] },
      seedDirs: ['/shared-a'],
    })
    expect(onlyMissing.service.globalMemorySources()).toEqual([])
    expect(onlyMissing.ctx.warnings.join('\n')).toBe('')
  })

  it('refuses a hand-edited vaults.json globalFile that climbs out of the vault', () => {
    // Row config and addVault reject `..` shapes; this belt guards the only
    // remaining entry point, a hand-edited card file.
    const h = harness({
      seedDirs: ['/card-escape', '/elsewhere'],
      seedFiles: {
        [VAULTS_JSON]: JSON.stringify({ version: 1, vaults: [
          { path: '/card-escape', mode: 'shared', globalFile: '../elsewhere/GLOBAL.md' },
        ] }),
        '/elsewhere/GLOBAL.md': '# outside the vault\n',
      },
    })
    expect(h.service.listVaults()).toHaveLength(1)
    expect(h.service.globalMemorySources()).toEqual([])
  })
})

describe('read: stats, slicing, read-only skip, registry', () => {
  const notePath = join(DEFAULT_VAULT, 'topic.md')
  const seededNote = `---
index_title: "Topic: scenario"
index_description: what this note decides
type: global
archive: false
created: 2026-11-01
updated: 2026-11-01
read_count: 4
keywords:
  - keepme
---
line one
line two
line three
`

  it('bumps read stats on shared vaults and preserves raw frontmatter', async () => {
    const h = harness({ seedFiles: { [notePath]: seededNote } })
    await h.service.ensureMemoryAccess()
    const result = await h.service.read(notePath)
    expect(result.meta.read_count).toBe(5)
    expect(result.meta.last_read_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.statsUpdated).toBe(true)
    const onDisk = parseNote(h.fs.content(notePath) ?? '')
    expect(onDisk.meta.read_count).toBe(5)
    expect(onDisk.raw?.keywords).toEqual(['keepme'])
    expect(h.service.readRecord(notePath)?.at).toBeGreaterThan(0)
  })

  it('skips the stats write on read-only vaults and flags it', async () => {
    const target = join('/ro', 'note.md')
    const h = harness({
      config: { vaults: [{ path: '/ro', mode: 'read-only' }] },
      seedDirs: ['/ro'],
      seedFiles: { [target]: seededNote },
    })
    await h.service.ensureMemoryAccess()
    const before = h.fs.content(target)
    const result = await h.service.read(target)
    expect(result.statsUpdated).toBe(false)
    expect(result.meta.read_count).toBe(4)
    expect(h.fs.content(target)).toBe(before)
  })

  it('slices the body with 1-based offset/limit and reports truncation', async () => {
    const h = harness({ seedFiles: { [notePath]: seededNote } })
    await h.service.ensureMemoryAccess()
    const page = await h.service.read(notePath, { offset: 2, limit: 1 })
    expect(page.body).toBe('line two')
    expect(page.totalLines).toBe(3)
    expect(page.truncated).toBe(true)
  })

  it('refuses paths outside registered vaults and missing files', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    await expect(h.service.read('/etc/passwd')).rejects.toThrow(/not inside any registered vault/)
    await expect(h.service.read(join(DEFAULT_VAULT, 'gone.md')))
      .rejects.toThrow(/does not exist/)
  })
})

describe('applyWrite and write', () => {
  const meta = testMeta()

  it('merges un-modelled raw frontmatter back before serializing', async () => {
    const target = join(DEFAULT_VAULT, 'keep.md')
    const existing = `---
index_title: Old title
index_description: old
type: global
archive: false
created: 2026-01-01
updated: 2026-01-01
read_count: 2
keywords:
  - alpha
trigger_extensions:
  - .ts
---
old body
`
    const h = harness({ seedFiles: { [target]: existing } })
    await h.service.ensureMemoryAccess()
    const result = await h.service.applyWrite(target, { ...meta, index_title: 'New title' }, 'new body\n')
    await h.service.flushWriteFollowUps()
    expect(result.created).toBe(false)
    expect(result.relPath).toBe('keep.md')
    const roundTrip = parseNote(h.fs.content(target) ?? '')
    expect(roundTrip.meta.index_title).toBe('New title')
    expect(roundTrip.body.trim()).toBe('new body')
    // TASK-025 carry-over #1: the un-modelled keys survive the rewrite.
    expect(roundTrip.raw?.keywords).toEqual(['alpha'])
    expect(roundTrip.raw?.trigger_extensions).toEqual(['.ts'])
    // Write-through: the indexer got the vault-root-relative path.
    expect(h.indexer.indexFile).toHaveBeenCalledWith(DEFAULT_VAULT, 'keep.md')
  })

  it('creates files inside shared vaults', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    const fresh = join(DEFAULT_VAULT, 'fresh.md')
    const result = await h.service.applyWrite(fresh, meta, 'body\n')
    expect(result.created).toBe(true)
    expect(h.fs.has(fresh)).toBe(true)
  })

  it('refuses read-only vaults, out-of-tree paths, reserved files, and invalid meta', async () => {
    const h = harness({
      config: { vaults: [{ path: '/ro', mode: 'read-only' }, { path: '/shared', mode: 'shared' }] },
      seedDirs: ['/ro', '/shared'],
    })
    await h.service.ensureMemoryAccess()
    await expect(h.service.applyWrite('/ro/x.md', meta, 'b')).rejects.toThrow(/read-only vault/)
    await expect(h.service.applyWrite('/shared/.obsidian-mem/x.md', meta, 'b'))
      .rejects.toThrow(/outside the indexed note tree/)
    await expect(h.service.applyWrite('/shared/.INTENTS.md', meta, 'b'))
      .rejects.toThrow(/reserved non-indexed/)
    await expect(h.service.write({
      path: '/shared/x.md', meta: { ...meta, index_description: '' }, body: 'b',
    })).rejects.toThrow(/index_description/)
  })

  it('write() runs the same path as applyWrite', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    const result = await h.service.write({
      path: join(DEFAULT_VAULT, 'w.md'), meta, body: 'b\n',
    })
    expect(result.created).toBe(true)
  })
})

// TASK-001 (PLAN-async-writes): applyWrite confirms the file write and
// leaves the index and git chains to settle asynchronously, tracked.
describe('write follow-up chains', () => {
  it('applyWrite resolves while a slow index chain is still pending, file on disk', async () => {
    const { git, h } = await writeReadyGitHarness()
    let indexSettled = false
    h.indexer.indexFile.mockImplementation(async () => {
      await new Promise((resolve) => { setTimeout(resolve, SLOW_CHAIN_MS) })
      indexSettled = true
      return true
    })

    const started = Date.now()
    const result = await h.service.applyWrite(join(h.vault, 'slow.md'), testMeta(), 'body\n')

    expect(result.relPath).toBe('slow.md')
    expect(h.fs.has(join(h.vault, 'slow.md'))).toBe(true)
    // The slow chain is still outstanding: the write did not await it.
    expect(indexSettled).toBe(false)
    expect(Date.now() - started).toBeLessThan(SLOW_CHAIN_MS)

    await h.service.flushWriteFollowUps()
    expect(indexSettled).toBe(true)
    expect(h.indexer.indexFile).toHaveBeenCalledWith(h.vault, 'slow.md')
    expect(commitMessages(git)).toEqual([
      expect.stringMatching(/^obsidian-mem: memory_write slow\.md /),
    ])
  })

  it('flushWriteFollowUps answers resolved when nothing is pending', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    await h.service.flushWriteFollowUps()
  })

  it('a rejecting indexFile settles quietly and leaves later follow-ups running', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    h.indexer.indexFile.mockRejectedValueOnce(new Error('embed exploded'))

    const first = await h.service.applyWrite(join(DEFAULT_VAULT, 'bad.md'), testMeta(), 'b\n')
    expect(first.created).toBe(true)
    await expect(h.service.flushWriteFollowUps()).resolves.toBeUndefined()
    expect(h.ctx.warnings.join('\n')).toContain('write follow-up failed: embed exploded')

    // The rejected chain left no wedge: the next write's chain still runs.
    const second = await h.service.applyWrite(join(DEFAULT_VAULT, 'good.md'), testMeta(), 'b\n')
    expect(second.created).toBe(true)
    await h.service.flushWriteFollowUps()
    expect(h.indexer.indexFile).toHaveBeenLastCalledWith(DEFAULT_VAULT, 'good.md')
    expect(h.indexer.indexFile).toHaveBeenCalledTimes(2)
  })

  it('a never-settling index chain does not hold the git chain of the same write', async () => {
    const { git, h } = await writeReadyGitHarness()
    h.indexer.indexFile.mockReturnValue(neverSettling<boolean>())

    await h.service.applyWrite(join(h.vault, 'stuck.md'), testMeta(), 'b\n')

    // flush only resolves after BOTH chains, so the pin observes order
    // through a race: the commit landed while flush is still blocked on
    // the stuck index chain.
    const outcome = await Promise.race([
      h.service.flushWriteFollowUps().then(() => 'flushed'),
      new Promise((resolve) => { setTimeout(resolve, 100, 'blocked') }),
    ])

    expect(outcome).toBe('blocked')
    expect(commitMessages(git)).toEqual([
      expect.stringMatching(/^obsidian-mem: memory_write stuck\.md /),
    ])
  })
})

// TASK-003 (PLAN-async-writes): the provisioning pass splits into the fast
// core half (writes gate here) and the index stack chained behind it
// (read-facing flows keep awaiting it). The launcher's start seam is
// parked per test so the core-landed, stack-pending window is observable.
describe('cold write access split', () => {
  const START_RESULT: MilvusStartResult = {
    address: '127.0.0.1:19530', version: 'milvus_lite-3.2.2', spawned: true,
  }

  /** ParkedStart parks launcher.start() and hands back its release switch. */
  function parkedStart(launcher: StubLauncher): {
    release(value: MilvusStartResult): void
    fail(error: Error): void
  } {
    let settle!: { resolve(value: MilvusStartResult): void, reject(error: Error): void }
    launcher.start.mockReturnValue(
      new Promise<MilvusStartResult>((resolve, reject) => {
        settle = { resolve, reject }
      }),
    )
    return {
      release(value) { settle.resolve(value) },
      fail(error) { settle.reject(error) },
    }
  }

  it('applyWrite resolves while launcher.start() never resolves, file landed', async () => {
    const h = harness()
    h.launcher.start.mockReturnValue(neverSettling<MilvusStartResult>())

    const result = await h.service.applyWrite(join(DEFAULT_VAULT, 'cold.md'), testMeta(), 'body\n')

    expect(result.created).toBe(true)
    expect(h.fs.has(join(DEFAULT_VAULT, 'cold.md'))).toBe(true)
    // Core provisioning landed (registry + dirs + stack kicked); the write
    // did not await the parked stack.
    expect(h.service.listVaults().map((v) => v.path)).toContain(DEFAULT_VAULT)
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
    expect(h.service.status().state).toBe('provisioning')
    // Chain 1 skipped: the indexer is still null behind the parked stack;
    // the stack's own full-scan converges the path (chain comment).
    expect(h.indexer.indexFile).not.toHaveBeenCalled()

    // A parked stack cannot wedge teardown either.
    await h.service.flushWriteFollowUps()
    await h.service.stop()
    expect(h.launcher.dispose).toHaveBeenCalledTimes(1)
  })

  it('search behind a parked launcher answers only after readiness lands', async () => {
    const h = harness()
    const parked = parkedStart(h.launcher)
    let searchSettled = false
    const searching = h.service.search({ query: 'anything' }).then(
      (results) => {
        searchSettled = true
        return results
      },
      (error: unknown) => {
        searchSettled = true
        throw error
      },
    )

    await new Promise((resolve) => { setTimeout(resolve, 20) })
    // Still awaiting the full pass: readiness, not just core.
    expect(searchSettled).toBe(false)

    parked.release(START_RESULT)
    const results = await searching
    expect(searchSettled).toBe(true)
    expect(results).toHaveLength(1)
    expect(h.client.calls).toContain('search')
    expect(h.service.status().state).toBe('ready')
  })

  it('search behind a parked launcher rejects only once the stack degrades', async () => {
    const h = harness()
    const parked = parkedStart(h.launcher)
    let searchSettled = false
    const searching = h.service.search({ query: 'anything' }).catch((error: unknown) => {
      searchSettled = true
      throw error
    })

    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(searchSettled).toBe(false)

    parked.fail(new Error('uvx missing and install failed'))
    await expect(searching).rejects.toThrow(/memory index is offline/)
    expect(h.service.status().state).toBe('degraded')
    expect(h.service.status().milvus.error).toContain('uvx missing')
  })

  it('the one-time notice lands once, on the write-path trigger', async () => {
    const h = harness()
    const parked = parkedStart(h.launcher)
    const writeNoticePromise = h.service.ensureWriteAccess()
    const memoryNoticePromise = h.service.ensureMemoryAccess()
    parked.release(START_RESULT)

    expect(await writeNoticePromise).toContain('default memory vault')
    expect(await memoryNoticePromise).toBeUndefined()
    // The flight settled ready: neither entry re-announces.
    expect(await h.service.ensureWriteAccess()).toBeUndefined()
    expect(await h.service.ensureMemoryAccess()).toBeUndefined()
  })

  it('status reports provisioning between core completion and stack completion', async () => {
    const h = harness()
    const parked = parkedStart(h.launcher)
    await h.service.ensureWriteAccess()

    // Core landed (vault registry, dirs); the stack is parked mid-boot:
    // the honest in-between the card shows.
    expect(h.service.listVaults().map((v) => v.path)).toContain(DEFAULT_VAULT)
    expect(h.service.status().state).toBe('provisioning')
    expect(h.service.status().milvus.version).toBeNull()

    parked.release(START_RESULT)
    await h.service.ensureMemoryAccess()
    expect(h.service.status().state).toBe('ready')
    expect(h.service.status().milvus.version).toBe('milvus_lite-3.2.2')
  })

  it('a hard core failure still rejects both entries and clears the flight', async () => {
    const h = harness({ failFirstMkdirp: true })
    await expect(h.service.ensureWriteAccess()).rejects.toThrow(/disk error mkdir/)
    expect(h.service.status().state).toBe('inactive')
    const notice = await h.service.ensureWriteAccess()
    expect(notice).toContain('default memory vault')
    await expect(h.service.ensureMemoryAccess()).resolves.toBeUndefined()
  })
})

describe('search', () => {
  it('passes through the two-route search dispatch once provisioned, resolving vault modes', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    const results = await h.service.search({ query: 'anything' })
    expect(results).toHaveLength(1)
    expect(results[0]!.mode).toBe('shared')
    expect(results[0]!.chunk_id).toBe(7)
    expect(h.client.calls).toContain('search')
  })

  it('throws IndexOfflineError when the index degraded, never crashes', async () => {
    const h = harness({ milvusFail: 'port held by a foreign server' })
    await h.service.ensureMemoryAccess()
    await expect(h.service.search({ query: 'anything' })).rejects.toThrow(/memory index is offline/)
    expect(h.service.status().state).toBe('degraded')
  })

  it('throws IndexOfflineError when the child died mid-session', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    h.launcher.setDegraded(true)
    await expect(h.service.search({ query: 'anything' })).rejects.toThrow(/respawn is pending/)
  })

  it('searchExactSections shares the pipeline and the offline discipline', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    const results = await h.service.searchExactSections({
      filePath: '/work/src/App.tsx',
      ext: '.tsx',
      snippet: 'import { App } from "./App"',
      fileTokens: ['app', 'src'],
    })
    expect(results[0]?.chunk_id).toBe(7)
    expect(h.client.calls).toContain('search')

    h.launcher.setDegraded(true)
    await expect(h.service.searchExactSections({ filePath: 'src/App.tsx' }))
      .rejects.toThrow(/respawn is pending/)
  })
})

describe('status, placeholders, and not-implemented seams', () => {
  it('status is side-effect free before provisioning', () => {
    const h = harness()
    const status = h.service.status()
    expect(status.state).toBe('inactive')
    expect(status.vaults).toEqual([])
    expect(status.milvus.address).toBeNull()
    expect(status.milvus.dbPath).toBe(DB_PATH)
    expect(status.indexer).toBeNull()
    expect(h.fs.mutations).toEqual([])
  })

  it('status reports the live index once ready', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    const status = h.service.status()
    expect(status.state).toBe('ready')
    expect(status.notice).toContain('default memory vault')
    expect(status.defaultVaultPath).toBe(DEFAULT_VAULT)
    expect(status.indexer).toEqual({ indexed: 3, pending: 0, errors: 0, llmErrors: 0 })
    expect(status.vectorDim).toBe(VECTOR_DIM_DEFAULT)
  })

  it('globalMemoryIndex reports the configured budget with zero use until wired', () => {
    const h = harness({ config: { budgets: { globalMemoryTokens: 2500 } } })
    expect(h.service.globalMemoryIndex()).toEqual({
      budgetTokens: 2500,
      usedTokens: 0,
      remainingTokens: 2500,
      overBudget: false,
    })
    expect(harness().service.globalMemoryIndex().budgetTokens).toBe(GLOBAL_MEMORY_TOKENS)
  })

  it('globalMemoryIndex echoes the wired registry with the flip at the cap', () => {
    const h = harness({ config: { budgets: { globalMemoryTokens: 2500 } } })
    let used = 2400
    h.service.setSessionRegistry({
      totalRecallTokensUsed: () => used,
      resetRecallUsage: () => { used = 0 },
    })
    expect(h.service.globalMemoryIndex()).toEqual({
      budgetTokens: 2500,
      usedTokens: 2400,
      remainingTokens: 100,
      overBudget: false,
    })
    // Exactly at the cap is not over; the flip happens at cap + 1.
    used = 2500
    expect(h.service.globalMemoryIndex().overBudget).toBe(false)
    used = 2501
    expect(h.service.globalMemoryIndex()).toEqual({
      budgetTokens: 2500,
      usedTokens: 2501,
      remainingTokens: 0,
      overBudget: true,
    })
    h.service.setSessionRegistry(null)
    expect(h.service.globalMemoryIndex().usedTokens).toBe(0)
  })

  it('audit echoes the wired registry budget numbers (TASK-045)', async () => {
    const h = harness({ config: { budgets: { globalMemoryTokens: 2500 } } })
    await h.service.ensureMemoryAccess()
    h.service.setSessionRegistry({ totalRecallTokensUsed: () => 3200, resetRecallUsage: () => {} })
    const report = await h.service.audit()
    expect(report.budget.usedTokens).toBe(3200)
    expect(report.budget.budgetTokens).toBe(2500)
    expect(report.budget.measured).toBe(true)
    expect(report.budget.overBudget).toBe(true)
    const over = report.issues.find((entry) => entry.id === 'budget.over')
    expect(over?.detail).toContain('3200 of 2500 tokens used')
    // TASK-002 wording: the line names the window the number covers.
    expect(over?.detail).toContain('injected since the last successful dream or host restart')
    expect(over?.remediation).toContain('memory_dream')
  })

  it('setSessionRegistry wires the events-owned registry into the budget view', () => {
    const h = harness()
    expect(h.service.sessionRegistry).toBeNull()
    const registry = { totalRecallTokensUsed: () => 42, resetRecallUsage: () => {} }
    h.service.setSessionRegistry(registry)
    expect(h.service.sessionRegistry).toBe(registry)
    // TASK-045: the wired registry's sums feed globalMemoryIndex directly.
    expect(h.service.globalMemoryIndex().usedTokens).toBe(42)
    h.service.setSessionRegistry(null)
    expect(h.service.sessionRegistry).toBeNull()
    expect(h.service.globalMemoryIndex().usedTokens).toBe(0)
  })

  it('dream() defaults to the deterministic plan and seeds the prompt once', async () => {
    const h = harness()
    const result = await h.service.dream()
    expect(result.operation).toBe('plan')
    if (result.operation !== 'plan') {
      throw new Error('expected the plan operation')
    }
    expect(result.plan.candidates).toEqual([])
    expect(result.plan.prompt).toContain('dreaming agent')
    const promptPath = join(DB_PATH, 'dream-prompt.md')
    expect(h.fs.readFile(promptPath)).toContain('Obsidian Mem: dreaming protocol')
    // Write-once seed: a second plan sees the existing file untouched.
    await h.service.dream()
    expect(h.fs.mutations.filter((entry) => entry.includes('dream-prompt.md'))).toHaveLength(1)
  })

  it('status carries the dream orchestrator view without touching anything but the stamp', () => {
    const h = harness()
    const status = h.service.status()
    expect(status.dream).toEqual({ state: 'idle', blocked: expect.stringContaining('no agents service'), lastDreamAt: null, lastRun: null })
    expect(status.dreaming).toEqual({ schedules: [], model: '', nearDuplicateThreshold: DREAM_NEAR_DUPLICATE_THRESHOLD })
    expect(h.fs.mutations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TASK-002: dream run launch wiring through the ctx.get gateways. The
// agents-gateway double is the shared dream-testkit fakeGateway and the
// pin shape is the shared createdEntry, so both specs read one create()
// recorder (TASK-005; PLAN-dream-isolation TASK-007 dedupe).

describe('dream run launch wiring (TASK-002)', () => {
  it('launches with the host default-model selection in the create agentOptions', async () => {
    const agents = fakeGateway()
    const h = harness({
      services: {
        agents: agents.gateway,
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      },
    })
    const result = await h.service.dream({ operation: 'run' })
    if (result.operation !== 'run') {
      throw new Error('expected the run operation')
    }
    expect((await result.done).ok).toBe(true)
    expect(agents.created).toEqual([
      createdEntry({ sessionId: `dream-${result.id}`, provider: 'p', model: 'm', cwd: DB_PATH }),
    ])
  })

  it('blocks a run lacking the agentDefaultModel service and launches nothing', async () => {
    const agents = fakeGateway()
    const h = harness({
      services: { agents: agents.gateway },
      // Provider is host-only (PLAN-dream-launch Decisions): a config model
      // alone cannot rescue the provider/model pair at the gate.
      config: { dreaming: { model: 'cfg/model' } } as ObsidianMemConfig,
    })
    await expect(h.service.dream({ operation: 'run' })).rejects.toThrow(
      'no provider/model can be resolved for the dream agent',
    )
    expect(agents.created).toEqual([])
    // The same reason surfaces on status so the card disables Run.
    expect(h.service.status().dream.blocked).toContain('no provider/model can be resolved')
  })
})

// ---------------------------------------------------------------------------
// PLAN-budget-rebaseline TASK-002: a successful dream run rewires the
// service-side DreamDeps.onRunSucceeded to the wired registry's
// resetRecallUsage, so the over-budget view recovers without a restart.

describe('dream budget rebaseline wiring', () => {
  it('a successful dream run resets the wired registry so the budget view recovers', async () => {
    const agents = fakeGateway()
    const h = harness({
      config: { budgets: { globalMemoryTokens: 2500 } },
      services: {
        agents: agents.gateway,
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      },
    })
    let used = 3200
    let resets = 0
    h.service.setSessionRegistry({
      totalRecallTokensUsed: () => used,
      resetRecallUsage: () => {
        used = 0
        resets += 1
      },
    })
    expect(h.service.globalMemoryIndex().overBudget).toBe(true)
    const result = await h.service.dream({ operation: 'run' })
    if (result.operation !== 'run') {
      throw new Error('expected the run operation')
    }
    expect((await result.done).ok).toBe(true)
    expect(resets).toBe(1)
    expect(h.service.globalMemoryIndex()).toEqual({
      budgetTokens: 2500,
      usedTokens: 0,
      remainingTokens: 2500,
      overBudget: false,
    })
  })

  it('a refused run leaves the wired registry usage untouched', async () => {
    const agents = fakeGateway()
    const h = harness({
      // Blocked: no agentDefaultModel service, so the run is refused.
      services: { agents: agents.gateway },
    })
    let resets = 0
    h.service.setSessionRegistry({
      totalRecallTokensUsed: () => 9999,
      resetRecallUsage: () => { resets += 1 },
    })
    await expect(h.service.dream({ operation: 'run' })).rejects.toThrow(
      'no provider/model can be resolved for the dream agent',
    )
    expect(agents.created).toEqual([])
    expect(resets).toBe(0)
    expect(h.service.globalMemoryIndex().usedTokens).toBe(9999)
  })
})

// ---------------------------------------------------------------------------
// PLAN-dream-isolation TASK-006: the dreamRunBusy() seam the events launch-
// window recall gate reads. It mirrors the orchestrator's live guard: false
// before any dream call (the getter reads the private field, it never
// constructs the engine), true while a run is in flight, false once settled.

describe('dreamRunBusy seam (PLAN-dream-isolation TASK-006)', () => {
  it('answers false before any dream call, true while a run is in flight, false after it settles', async () => {
    // The dream.spec order-independent in-flight idiom: drive() reaches
    // whenIdle only after plan()'s awaits, so the gate records resolvers
    // until it opens and resolves immediately (or later) once opened.
    let opened = false
    const resolvers: Array<() => void> = []
    const agents = fakeGateway({
      whenIdle: () => (opened ? Promise.resolve() : new Promise<void>((resolve) => { resolvers.push(resolve) })),
    })
    const h = harness({
      services: {
        agents: agents.gateway,
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      },
    })
    expect(h.service.dreamRunBusy()).toBe(false)
    const result = await h.service.dream({ operation: 'run' })
    if (result.operation !== 'run') {
      throw new Error('expected the run operation')
    }
    expect(h.service.dreamRunBusy()).toBe(true)
    opened = true
    resolvers.splice(0).forEach((resolve) => {
      resolve()
    })
    expect((await result.done).ok).toBe(true)
    expect(h.service.dreamRunBusy()).toBe(false)
  })

  it('a plan leaves the seam answering false', async () => {
    const h = harness()
    const result = await h.service.dream()
    expect(result.operation).toBe('plan')
    expect(h.service.dreamRunBusy()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PLAN-config-pane TASK-004: the live card-settings escalation on a fully
// provisioned stack (budgets in-place, thinkShots to the registry, llm and
// model/dim re-forms, dbPath persist-only, ordering guard + rollback).

describe('card settings live apply (TASK-004)', () => {
  const vaultStatePath = join(metadataDir('/vault'), 'obsidian-mem-state.json')
  const vaultSeeds = {
    config: { vaults: [{ path: '/vault', mode: 'shared' }] } as ObsidianMemConfig,
    seedDirs: ['/vault'],
    seedFiles: { [vaultStatePath]: '{"version":1,"modelId":"x","vectorDim":384,"files":{}}' },
  }

  it('swaps budgets in place while ready: call-time readers see them, nothing pends', async () => {
    const h = harness(vaultSeeds)
    await h.service.ensureMemoryAccess()
    // defaultTokenCap wiring: the stub row's chunk_text survives the
    // 350-token default and truncates once the patched cap is in force.
    const before = await h.service.search({ query: 'anything' })
    expect(before[0]!.chunk_text).toBe('the fact, stated plainly')

    const view = await h.service.updateCardSettings({
      set: { budgets: { searchTopK: 8, readSectionTokens: 1 } },
    })
    expect(h.service.config.budgets.searchTopK).toBe(8)
    expect(h.service.status().budgets.readSectionTokens).toBe(1)
    expect(view.restartPending).toEqual([])
    // Call-time reads: the search pipeline runs the new cap without a
    // re-form, and budgets alone never re-form the indexer.
    const after = await h.service.search({ query: 'anything' })
    expect(after[0]!.chunk_text).toBe('the ')
    expect(h.indexer.builtWithOptions).toHaveLength(1)
  })

  it('forwards budgets.thinkShotsPerTurn to the wired registry setter', async () => {
    const h = harness(vaultSeeds)
    await h.service.ensureMemoryAccess()
    const setThinkShotsPerTurn = vi.fn()
    h.service.setSessionRegistry({
      totalRecallTokensUsed: () => 0,
      resetRecallUsage: () => {},
      setThinkShotsPerTurn,
    })
    await h.service.updateCardSettings({ set: { budgets: { thinkShotsPerTurn: 5 } } })
    expect(h.service.config.budgets.thinkShotsPerTurn).toBe(5)
    expect(setThinkShotsPerTurn).toHaveBeenCalledWith(5)
  })

  it('tolerates a wired registry without the optional setter', async () => {
    const h = harness(vaultSeeds)
    h.service.setSessionRegistry({ totalRecallTokensUsed: () => 0, resetRecallUsage: () => {} })
    const view = await h.service.updateCardSettings({ set: { budgets: { thinkShotsPerTurn: 4 } } })
    expect(h.service.config.budgets.thinkShotsPerTurn).toBe(4)
    expect(view.restartPending).toEqual([])
  })

  it('re-forms the indexer with the new llm options on an llm patch', async () => {
    const h = harness(vaultSeeds)
    await h.service.ensureMemoryAccess()
    expect(h.indexer.builtWithOptions[0]!.llm).toBeUndefined()
    const view = await h.service.updateCardSettings({
      set: { llm: { enabled: true, baseUrl: 'https://infer.local', model: 'm1', apiKeyEnv: 'LLM_KEY' } },
    })
    expect(h.indexer.stop).toHaveBeenCalledTimes(1)
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(h.indexer.builtWithOptions[1]!.llm).toEqual({
      enabled: true,
      baseUrl: 'https://infer.local',
      model: 'm1',
      apiKeyEnv: 'LLM_KEY',
    })
    expect(h.indexer.start).toHaveBeenCalledTimes(2)
    expect(view.restartPending).toEqual([])
    // No collection work for an llm move.
    expect(h.client.calls).not.toContain('dropCollection')
  })

  it('rebuilds the collection and re-forms over a new embedder on a vectorDim move', async () => {
    const h = harness({ ...vaultSeeds, existingDim: 384, noEmbedderSeam: true })
    await h.service.ensureMemoryAccess()
    expect(h.fs.has(vaultStatePath)).toBe(true)

    const view = await h.service.updateCardSettings({ set: { vectorDim: 256 } })
    expect(h.service.config.vectorDim).toBe(256)
    // The provision step-5 pair ran: drift rebuild, forced full reindex.
    expect(h.client.calls).toContain('dropCollection')
    expect(h.client.calls.filter((call) => call === 'createCollection')).toHaveLength(1)
    expect(h.fs.has(vaultStatePath)).toBe(false)
    // The dropped lazy embedder re-built over the new width (the dim is
    // baked into it), and the indexer re-formed.
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(h.indexer.builtWithOptions[0]!.embedder.dim).toBe(384)
    expect(h.indexer.builtWithOptions[1]!.embedder.dim).toBe(256)
    expect(h.indexer.builtWithOptions[1]!.embedder)
      .not.toBe(h.indexer.builtWithOptions[0]!.embedder)
    expect(view.restartPending).toEqual([])
  })

  it('keeps the hooks.embedder seam authoritative across a model.id move', async () => {
    const h = harness({ ...vaultSeeds, existingDim: 384 })
    await h.service.ensureMemoryAccess()
    const callsBefore = h.client.calls.length
    await h.service.updateCardSettings({ set: { model: { id: 'custom/embed-model' } } })
    expect(h.service.config.model.id).toBe('custom/embed-model')
    // Same width: no collection pair, just the indexer re-form.
    expect(h.client.calls.slice(callsBefore)).not.toContain('dropCollection')
    expect(h.fs.has(vaultStatePath)).toBe(true)
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(h.indexer.builtWithOptions[1]!.embedder)
      .toBe(h.indexer.builtWithOptions[0]!.embedder)
  })

  it('mutates config only when nothing is provisioned', async () => {
    const h = harness(vaultSeeds)
    const view = await h.service.updateCardSettings({ set: { vectorDim: 256 } })
    expect(h.service.config.vectorDim).toBe(256)
    expect(h.client.calls).toEqual([])
    expect(h.indexer.builtWithOptions).toEqual([])
    expect(h.fs.has(vaultStatePath)).toBe(true)
    expect(view.restartPending).toEqual([])
  })

  it('keeps milvus.dbPath persist-only: it pends, no subsystem is touched', async () => {
    const h = harness(vaultSeeds)
    await h.service.ensureMemoryAccess()
    const callsBefore = h.client.calls.length
    const view = await h.service.updateCardSettings({ set: { milvus: { dbPath: '/second/db' } } })
    expect(view.settings.milvus.dbPath).toBe('/second/db')
    expect(view.restartPending).toEqual(['milvus.dbPath'])
    // The running subsystems stay on the boot dbPath.
    expect(h.service.config.milvus.dbPath).toBe(DB_PATH)
    expect(h.client.calls).toHaveLength(callsBefore)
    expect(h.launcher.start).toHaveBeenCalledTimes(1)
    expect(h.indexer.builtWithOptions).toHaveLength(1)
  })

  it('waits an in-flight provisioning pass before applying', async () => {
    const h = harness(vaultSeeds)
    const access = h.service.ensureMemoryAccess()
    const applying = h.service.updateCardSettings({ set: { budgets: { searchTopK: 8 } } })
    // The chain is parked on the provisioning pass: nothing applied yet.
    expect(h.service.config.budgets.searchTopK).toBe(6)
    await access
    const view = await applying
    expect(h.service.config.budgets.searchTopK).toBe(8)
    expect(view.restartPending).toEqual([])
  })

  it('answers a vectorDim move during provisioning with the settled step-5 drift pass', async () => {
    const h = harness({ ...vaultSeeds, existingDim: 384 })
    const access = h.service.ensureMemoryAccess()
    const applying = h.service.updateCardSettings({ set: { vectorDim: 256 } })
    await access
    const view = await applying
    // Provisioning itself created the collection at the boot 384 width;
    // the settled apply saw the drift and rebuilt.
    expect(h.client.calls).toContain('dropCollection')
    expect(h.fs.has(vaultStatePath)).toBe(false)
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(view.restartPending).toEqual([])
  })

  it('rolls the config back and rejects when the re-form fails', async () => {
    const h = harness({ ...vaultSeeds, existingDim: 384 })
    await h.service.ensureMemoryAccess()
    // Break the collection pair after the boot pass succeeded.
    const broken = h.client as unknown as { hasCollection(): Promise<never> }
    broken.hasCollection = async () => {
      throw new Error('milvus describe exploded')
    }
    await expect(h.service.updateCardSettings({ set: { vectorDim: 256 } }))
      .rejects.toThrow(/card settings apply failed/)
    // Previous values stay applied; the persisted delta reports itself.
    expect(h.service.config.vectorDim).toBe(384)
    expect(h.service.cardSettings().restartPending).toEqual(['vectorDim'])
    // The rollback re-formed the indexer over the restored config: the
    // old manager is stopped and a live one is in place, never dangling.
    expect(h.indexer.builtWithOptions).toHaveLength(2)
    expect(h.indexer.start).toHaveBeenCalledTimes(2)
  })
})

describe('teardown', () => {
  it('stops the indexer, kills the child, and closes the client once', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    expect(h.ctx.effects.map((effect) => effect.label)).toContain('obsidianMem.effects')

    await h.service.stop()
    await h.service.stop()
    expect(h.indexer.stop).toHaveBeenCalledTimes(1)
    expect(h.launcher.dispose).toHaveBeenCalledTimes(1)
    expect(h.client.closeConnection).toHaveBeenCalledTimes(1)

    // The scope effect runs the same idempotent stop.
    for (const effect of h.ctx.effects) {
      await effect.dispose()
    }
    expect(h.launcher.dispose).toHaveBeenCalledTimes(1)
  })

  it('teardown before provisioning touches nothing', async () => {
    const h = harness()
    await h.service.stop()
    expect(h.indexer.stop).not.toHaveBeenCalled()
    expect(h.launcher.dispose).not.toHaveBeenCalled()
  })

  // TASK-002 (PLAN-async-writes): teardown drains the tracked write
  // follow-up chains up to TEARDOWN_FLUSH_TIMEOUT_MS before the indexer
  // stops, so in-flight index/commit bookkeeping lands on a clean shutdown
  // and a wedged chain can never hang teardown.
  it('a pending write chain drains before the indexer stops', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    let chainSettled = false
    h.indexer.indexFile.mockImplementation(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
      chainSettled = true
      return true
    })
    const settledAtStop: boolean[] = []
    h.indexer.stop.mockImplementation(() => {
      settledAtStop.push(chainSettled)
    })

    await h.service.applyWrite(join(DEFAULT_VAULT, 'drain.md'), testMeta(), 'body\n')
    await h.service.stop()

    // The bounded flush inside teardown waited for the ~10 ms chain.
    expect(settledAtStop).toEqual([true])
    expect(h.indexer.indexFile).toHaveBeenCalledWith(DEFAULT_VAULT, 'drain.md')
    expect(h.ctx.warnings.join('\n')).not.toContain('write-follow-up flush')
  })

  it('a never-settling chain caps the flush: teardown completes, warns, disposes', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()
    h.indexer.indexFile.mockReturnValue(neverSettling<boolean>())
    await h.service.applyWrite(join(DEFAULT_VAULT, 'stuck.md'), testMeta(), 'body\n')

    // Virtual setTimeout (Date stays real) so the imported
    // TEARDOWN_FLUSH_TIMEOUT_MS cap fires without waiting out its real
    // duration; the margin pins that teardown only waited for the cap timer,
    // never for the wedged chain.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const started = Date.now()
      const stopping = h.service.stop()
      await vi.advanceTimersByTimeAsync(TEARDOWN_FLUSH_TIMEOUT_MS)
      await stopping
      expect(Date.now() - started).toBeLessThan(TEARDOWN_MARGIN_MS)
    } finally {
      vi.useRealTimers()
    }

    // The git chain settled; only the wedged index chain is still held.
    expect(h.ctx.warnings.join('\n')).toContain('1 follow-up chain(s) still unsettled')
    expect(h.indexer.stop).toHaveBeenCalledTimes(1)
    expect(h.launcher.dispose).toHaveBeenCalledTimes(1)
    expect(h.client.closeConnection).toHaveBeenCalledTimes(1)
  })

  it('an empty follow-up queue settles teardown without waiting', async () => {
    const h = harness()
    await h.service.ensureMemoryAccess()

    const started = Date.now()
    await h.service.stop()

    expect(Date.now() - started).toBeLessThan(TEARDOWN_MARGIN_MS)
    expect(h.ctx.warnings.join('\n')).not.toContain('write-follow-up flush')
  })
})

// ---------------------------------------------------------------------------
// Vault git wiring (TASK-004). Real temp-dir vault roots (MemoryGit writes
// its .gitignore through node:fs) behind a recording fake GitRunner; the
// manager-level policy pins live in tests/vault-git.spec.ts.

describe('vault git wiring', () => {
  /** Flush drains the floating addVault adoption promise (microtask-only chain). */
  async function flush(): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }

  it('construction and activation never touch git, even with git enabled', () => {
    const git = recordingGit()
    // gitWriteHarness only constructs the service; nothing has reached git.
    gitWriteHarness(git)
    expect(git.calls).toEqual([])
  })

  it('provisioning adopts every shared vault and never the read-only one', async () => {
    const sharedA = gitTempDir()
    const sharedB = gitTempDir()
    const readOnly = gitTempDir()
    const git = recordingGit()
    const h = gitVaultHarness(git, [
      { path: sharedA },
      { path: sharedB },
      { path: readOnly, mode: 'read-only' },
    ])

    await h.service.ensureMemoryAccess()

    const roots = [...new Set(git.calls.map((call) => call.root))].sort()
    expect(roots).toEqual([sharedA, sharedB].sort())
    expect(git.calls.some((call) => call.root === sharedA && call.argv.join(' ').includes('--git-dir')))
      .toBe(true)
    expect(h.ctx.errors).toEqual([])
  })

  it('addVault adopts the new shared vault after the registry commit; a read-only add never lands in git', async () => {
    const existing = gitTempDir()
    const fresh = gitTempDir()
    const readOnly = gitTempDir()
    const git = recordingGit()
    const h = harness({
      gitEnabled: true,
      seedDirs: [existing, readOnly],
      config: { vaults: [{ path: existing }] },
      gitRunner: git.gitRunner,
    })

    h.service.addVault({ path: fresh })
    await flush()
    expect(git.calls.some((call) => call.root === fresh && call.argv.join(' ').includes('--git-dir')))
      .toBe(true)

    git.calls.length = 0
    h.service.addVault({ path: readOnly, mode: 'read-only' })
    await flush()
    expect(git.calls.filter((call) => call.root === readOnly)).toEqual([])
  })

  it('a failed adoption is logged and the service keeps serving', async () => {
    const git = recordingGit({ adoptionFails: true })
    const h = gitWriteHarness(git)

    await h.service.ensureMemoryAccess()

    expect(h.ctx.errors.join('\n')).toContain(`git adoption failed for vault ${h.vault}`)
    expect(h.service.status().state).toBe('ready')
    expect(h.service.listVaults().map((entry) => entry.path)).toContain(h.vault)
    expect(h.service.vaultGit.adoptedRoots()).toEqual([])
  })

  it('a disabled boot config touches no git; the live flip adopts on the next call', async () => {
    const existing = gitTempDir()
    const fresh = gitTempDir()
    const git = recordingGit()
    const h = harness({
      seedDirs: [existing],
      config: { vaults: [{ path: existing }] },
      gitRunner: git.gitRunner,
    })

    await h.service.ensureMemoryAccess()
    expect(git.calls).toEqual([])

    // The live group swap escalateCardSettings performs for a git.* patch.
    h.service.config.git = { ...h.service.config.git, enabled: true }
    h.service.addVault({ path: fresh })
    await flush()

    expect(git.calls.some((call) => call.root === fresh && call.argv.join(' ').includes('--git-dir')))
      .toBe(true)
    expect(git.calls.filter((call) => call.root === existing)).toEqual([])
  })

  it('removeVault forgets the vault git handle', async () => {
    const vault = gitTempDir()
    const git = recordingGit()
    const h = harness({ gitEnabled: true, gitRunner: git.gitRunner })

    h.service.addVault({ path: vault })
    await flush()
    expect(h.service.vaultGit.adoptedRoots()).toEqual([vault])
    await expect(h.service.vaultGit.statusShared(vault)).resolves.not.toBeNull()

    await h.service.removeVault(vault)
    expect(h.service.vaultGit.adoptedRoots()).toEqual([])
    await expect(h.service.vaultGit.statusShared(vault)).resolves.toBeNull()
  })

  // Write-commit seam (TASK-005, async since TASK-001): every successful
  // write fires one tracked commit follow-up in the owning shared vault,
  // serialized per vault by the manager (Q3 answer; no debounce, no
  // tools-layer changes); the tests flush to observe the settled chain.

  it('one successful write lands exactly one commit with the pinned message shape', async () => {
    const { git, h } = await writeReadyGitHarness()
    const result = await h.service.write({
      path: join(h.vault, 'topic.md'), meta: testMeta(), body: 'the fact, stated plainly\n',
    })
    await h.service.flushWriteFollowUps()

    expect(result.created).toBe(true)
    expect(result.vaultPath).toBe(h.vault)
    expect(commitMessages(git)).toEqual([
      expect.stringMatching(
        /^obsidian-mem: memory_write topic\.md \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    ])
    expect(h.ctx.errors).toEqual([])
  })

  it('an identical-content rewrite (clean tree) commits nothing and still returns written', async () => {
    const git = recordingGit()
    const h = gitWriteHarness(git)
    await h.service.ensureMemoryAccess()

    git.markDirty()
    const request = {
      path: join(h.vault, 'again.md'), meta: testMeta(), body: 'same bytes\n',
    }
    const first = await h.service.write(request)
    await h.service.flushWriteFollowUps()
    expect(first.created).toBe(true)
    expect(commitMessages(git)).toHaveLength(1)

    // The recorded commit cleaned the fake tree, which is what an
    // identical rewrite looks like to git: commitVault answers null and
    // the write still returns.
    const second = await h.service.write(request)
    await h.service.flushWriteFollowUps()
    expect(second.created).toBe(false)
    expect(commitMessages(git)).toHaveLength(1)
    expect(h.ctx.errors).toEqual([])
  })

  it('git disabled: the write never reaches the git boundary and still returns', async () => {
    const git = recordingGit()
    const vault = gitTempDir()
    const h = harness({
      seedDirs: [vault],
      config: { vaults: [{ path: vault }] },
      gitRunner: git.gitRunner,
    })
    await h.service.ensureMemoryAccess()

    const result = await h.service.write({
      path: join(vault, 'off.md'), meta: testMeta(), body: 'b\n',
    })
    await h.service.flushWriteFollowUps()

    expect(result.created).toBe(true)
    expect(git.calls).toEqual([])
  })

  it('a failing commit still returns the written result; the manager logs it', async () => {
    const { h } = await writeReadyGitHarness({ commitFails: true })
    const result = await h.service.write({
      path: join(h.vault, 'kept.md'), meta: testMeta(), body: 'b\n',
    })
    await h.service.flushWriteFollowUps()

    expect(result.created).toBe(true)
    expect(result.relPath).toBe('kept.md')
    expect(h.ctx.errors.join('\n')).toContain(`git commit failed for vault ${h.vault}`)
  })

  it('an archive write commits like any other write', async () => {
    const { git, h } = await writeReadyGitHarness()
    await h.service.write({
      path: join(h.vault, 'retired.md'), meta: testMeta({ archive: true }), body: 'b\n',
    })
    await h.service.flushWriteFollowUps()

    expect(parseNote(h.fs.content(join(h.vault, 'retired.md')) ?? '').meta.archive).toBe(true)
    expect(commitMessages(git)).toHaveLength(1)
  })

  it('a read-only vault write is refused before git is ever consulted', async () => {
    const git = recordingGit()
    const shared = gitTempDir()
    const readOnly = gitTempDir()
    const h = gitVaultHarness(git, [{ path: shared }, { path: readOnly, mode: 'read-only' }])
    await h.service.ensureMemoryAccess()

    await expect(h.service.applyWrite(join(readOnly, 'x.md'), testMeta(), 'b'))
      .rejects.toThrow(/read-only vault/)
    expect(git.calls.filter((call) => call.root === readOnly)).toEqual([])
  })

  // Audit seam (TASK-008): git facts reach the report only through the
  // manager's read-only accessors; the audit never adopts and never mutates.

  /**
   * AuditGitRunner: a healthy adopted repo answering the adoption probes,
   * a two-commit log (newest first, both touching alpha.md, the older one
   * also beta.md), and a clean status.
   */
  function auditGitRunner() {
    const calls: Array<{ root: string; argv: string[] }> = []
    const logRecord = (hash: string, paths: string[]): string =>
      `\u001e${hash}\u001f2026-11-10T00:00:00+00:00\u001fobsidian-mem: memory_write\n${paths.join('\n')}\n`
    const gitRunner = (root: string): GitRunner => async (argv) => {
      calls.push({ root, argv })
      if (argv.includes('log')) {
        return {
          code: 0,
          stdout: `${logRecord('e'.repeat(40), ['alpha.md'])}${logRecord('d'.repeat(40), ['alpha.md', 'beta.md'])}`,
          stderr: '',
        }
      }
      if (argv.includes('status')) {
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' }
    }
    return { calls, gitRunner }
  }

  it('audit never adopts: an unmanaged shared vault answers initialized false with zero git calls', async () => {
    const git = recordingGit()
    const h = gitWriteHarness(git)

    const report = await h.service.audit()

    expect(git.calls).toEqual([])
    expect(report.stats.git).toEqual([{ vault: h.vault, initialized: false, clean: null, headHash: null, error: null }])
    expect(report.issues.filter((entry) => entry.id === 'git-not-adopted').map((entry) => entry.severity))
      .toEqual(['INFO'])
    expect(report.rows.every((row) => row.churn === 0)).toBe(true)
  })

  it('audit reads churn and the rollup from an adopted vault behind the window knob', async () => {
    const vault = gitTempDir()
    // Real note files: the service audit walks the auditFs default (the
    // real disk), so the rows exist only where nodeAuditFs can see them.
    writeFileSync(join(vault, 'alpha.md'), serializeNoteWithRaw({ meta: testMeta({ index_title: 'Alpha: one' }), body: 'fact\n' }), 'utf8')
    writeFileSync(join(vault, 'beta.md'), serializeNoteWithRaw({ meta: testMeta({ index_title: 'Beta: two' }), body: 'fact\n' }), 'utf8')
    const git = auditGitRunner()
    const h = gitVaultHarness(git, [{ path: vault }])
    // The live group swap a card churnWindowCommits patch performs.
    h.service.config.git = { ...h.service.config.git, churnWindowCommits: 1 }

    await h.service.ensureMemoryAccess()
    const report = await h.service.audit()

    expect(report.stats.git).toEqual([
      { vault, initialized: true, clean: true, headHash: 'e'.repeat(40), error: null },
    ])
    const logWindowArgs = git.calls
      .filter((call) => call.argv.includes('log'))
      .map((call) => call.argv.find((arg) => arg.startsWith('--max-count=')))
    expect(logWindowArgs).toEqual(['--max-count=1'])
    // The window is one commit wide: alpha sits in all of it, beta in none.
    expect(report.rows.find((row) => row.path === join(vault, 'alpha.md'))?.churn).toBe(1)
    expect(report.rows.find((row) => row.path === join(vault, 'beta.md'))?.churn).toBe(0)
    expect(git.calls.some((call) => call.argv.includes('init'))).toBe(false)
  })

  // Dream-commit seam (TASK-006): the dream ok path closes with one
  // commitAllShared pass, and the launch text names the adopted roots for
  // the prompt's Step 0 Pre-Sync step.

  /** DreamGitHarness: a git-enabled service with the launch gateways mounted. */
  function dreamGitHarness(git: ReturnType<typeof recordingGit>, gitEnabled: boolean) {
    const vault = gitTempDir()
    const agents = fakeGateway()
    const h = harness({
      gitEnabled,
      seedDirs: [vault],
      config: { vaults: [{ path: vault }] },
      gitRunner: git.gitRunner,
      services: {
        agents: agents.gateway,
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      },
    })
    return { ...h, vault, agents }
  }

  /** LaunchText: the followup text the dream agent double received. */
  function launchText(agents: ReturnType<typeof fakeGateway>): string {
    const followup = agents.followups[0] as { content: Array<{ type: string; text: string }> }
    return followup.content[0]?.text ?? ''
  }

  it('a successful dream run records one commit pass and names the adopted roots in the launch text', async () => {
    const git = recordingGit()
    const h = dreamGitHarness(git, true)
    await h.service.ensureMemoryAccess()
    git.calls.length = 0
    git.markDirty()

    const result = await h.service.dream({ operation: 'run' })
    if (result.operation !== 'run') {
      throw new Error('expected the run operation')
    }
    const summary = await result.done
    expect(summary.ok).toBe(true)
    expect(commitMessages(git)).toEqual([
      expect.stringMatching(
        /^obsidian-mem: dream \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    ])
    expect(summary.summary).toContain(`git: ${h.vault}=${'f'.repeat(7)}`)
    expect(launchText(h.agents)).toContain(
      `Memory git roots (for the Pre-Sync step): ${h.vault}`,
    )
    expect(h.ctx.errors).toEqual([])
  })

  it('a git-disabled dream run reaches no git boundary and omits the roots line', async () => {
    const git = recordingGit()
    const h = dreamGitHarness(git, false)
    await h.service.ensureMemoryAccess()

    const result = await h.service.dream({ operation: 'run' })
    if (result.operation !== 'run') {
      throw new Error('expected the run operation')
    }
    expect((await result.done).ok).toBe(true)
    expect(git.calls).toEqual([])
    expect(launchText(h.agents)).not.toContain('Memory git roots')
  })
})
