import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import {
  DREAM_NEAR_DUPLICATE_THRESHOLD,
  GLOBAL_MEMORY_FILE_DEFAULT,
  GLOBAL_MEMORY_TOKENS,
  INTENTS_FILE,
  VECTOR_DIM_DEFAULT,
  dbDir,
  defaultVaultPath,
  metadataDir,
  parseNote,
  stateDir,
} from '../../core/lib/index.js'
import type { NoteMeta } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  ObsidianMemConfigSchema,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
} from '../src/config.ts'
import type { ObsidianMemConfig } from '../src/config.ts'
import { ObsidianMemService } from '../src/service.ts'
import type {
  IndexerLike,
  MilvusLauncherLike,
  ObsidianMemHooks,
  ServiceFs,
} from '../src/service.ts'
import type { MilvusLauncherOptions } from '../src/milvus/launcher.ts'
import type { IndexerManagerOptions } from '../src/indexer.ts'
import { fakeGateway } from './dream-testkit.ts'

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
 * teardown stops the indexer, kills the child, and closes the client.
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
  start: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  factoryOptions: MilvusLauncherOptions[]
  setDegraded(value: boolean): void
}

function stubLauncher(failMessage?: string): StubLauncher {
  const factoryOptions: MilvusLauncherOptions[] = []
  const launcher = {
    degraded: false,
    address: '127.0.0.1:19530',
    factoryOptions,
    start: vi.fn(async () => {
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

function stubClient(options: { existingDim?: number | null } = {}) {
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
            { name: 'content_vector', type: 'FloatVector', dim },
            { name: 'text_sparse', type: 'SparseFloatVector' },
          ],
        },
      }
    },
    async createCollection() { calls.push('createCollection'); dim = null; return ok },
    async createIndex() { calls.push('createIndex'); return ok },
    async loadCollectionSync() { calls.push('loadCollectionSync'); return ok },
    async dropCollection() { calls.push('dropCollection'); dim = null; return ok },
    async delete(request: Record<string, unknown>) { calls.push('delete'); deletes.push(request); return ok },
    async count() { calls.push('count'); return { ...ok, data: 1 } },
    async search(request: Record<string, unknown>) {
      calls.push('search')
      // Route-aware row: the dense route gets a within-radius score, the
      // sparse route a negated-relevance score past the client-side floor.
      // One row surviving BOTH routes at rank 1 fuses to 2/61, the shape
      // the TASK-009 fallback agreement floor keeps.
      const dense = request['anns_field'] === 'content_vector'
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
          score: dense ? 0.91 : -3.0,
        }],
      }
    },
    closeConnection: vi.fn(async () => {}),
  }
}

interface StubIndexer extends IndexerLike {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  indexFile: ReturnType<typeof vi.fn>
  reindexAll: ReturnType<typeof vi.fn>
  builtWithOptions: IndexerManagerOptions[]
}

function stubIndexer(): StubIndexer {
  const builtWithOptions: IndexerManagerOptions[] = []
  return {
    builtWithOptions,
    start: vi.fn(),
    stop: vi.fn(),
    reindexAll: vi.fn(async () => {}),
    indexFile: vi.fn(async () => true),
    progress: () => ({ indexed: 3, pending: 0, errors: 0, llmErrors: 0 }),
  }
}

// ---------------------------------------------------------------------------
// Harness.

const HOME = '/home/test'
const DB_PATH = dbDir(HOME)
const VAULTS_JSON = join(stateDir(HOME), 'vaults.json')
const DEFAULT_VAULT = defaultVaultPath(HOME)

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
    embedder: fakeEmbedder({ vectorDim: options.config?.vectorDim ?? VECTOR_DIM_DEFAULT }),
    indexerFactory: (managerOptions) => {
      indexer.builtWithOptions.push(managerOptions)
      return indexer
    },
    prewarm,
  }
  const service = new ObsidianMemService(ctx.ctx, options.config ?? {}, hooks)
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

// ---------------------------------------------------------------------------

describe('config schema', () => {
  const fullDefaults = {
    vaults: [],
    vectorDim: 384,
    model: { id: 'Xenova/multilingual-e5-small', dtype: 'q8' },
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
  }

  it('resolves {} (and undefined) to the complete default config', () => {
    expect(validateObsidianMemConfig({}).value).toEqual(fullDefaults)
    expect(validateObsidianMemConfig(undefined).value).toEqual(fullDefaults)
  })

  it('carries unknown keys onto a symbol, never into the resolved value', () => {
    const result = validateObsidianMemConfig({ bogus: 1, milvus: { mode: 'spawn', extra: 2 } })
    expect(result.issues).toBeUndefined()
    const value = result.value as typeof result.value & { [UNKNOWN_CONFIG_KEYS]?: string[] }
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
    expect(validateObsidianMemConfig({ vectorDim: 256 }).value?.vectorDim).toBe(256)
    expect(validateObsidianMemConfig({ vectorDim: 999 }).issues?.[0]?.message)
      .toMatch(/384 \(full width\).*128\/192\/256\/320/)
  })

  it('defaults vault modes and globalFile and rejects bad ones with a path', () => {
    const ok = validateObsidianMemConfig({ vaults: [{ path: '/v' }] })
    expect(ok.value?.vaults).toEqual([{ path: '/v', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT }])
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
    expect(good.value?.dreaming.schedules).toHaveLength(2)
    const bad = validateObsidianMemConfig({
      dreaming: { schedules: [{ id: 'x', label: 'x' }] },
    })
    expect(bad.issues?.[0]?.message).toMatch(/exactly one of expression or everySeconds/)
  })

  it('exposes the same standard-schema through the static Config', () => {
    expect(ObsidianMemService.Config['~standard'].vendor).toBe('obsidian-mem')
    expect(ObsidianMemService.Config['~standard'].validate({}).issues).toBeUndefined()
    expect(ObsidianMemConfigSchema).toBe(ObsidianMemService.Config)
  })

  it('resolveServiceConfig expands ~ and defaults dbPath from core dbDir', () => {
    const resolved = validateObsidianMemConfig({
      vaults: [{ path: '~/notes' }, { path: '/abs' }],
    }).value!
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
    expect(validateObsidianMemConfig({}).value?.milvus.readinessTimeoutMs).toBe(600_000)
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
// agents-gateway double is the shared dream-testkit fakeGateway, so both
// specs read one create() recorder (TASK-005).

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
      { sessionId: `dream-${result.id}`, agentOptions: { provider: 'p', model: 'm' }, meta: { cwd: DB_PATH } },
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
})
