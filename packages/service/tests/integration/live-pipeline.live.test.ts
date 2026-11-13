/**
 * TASK-061 integration tier (live, opt-in): the whole memory pipeline
 * against REAL dependencies. Nothing here is faked:
 *
 * - transformers.js loads `Xenova/multilingual-e5-small` (q8) from the
 *   warm cache at `$HOME/.dsh/obsidian-mem/models` (see README "Model
 *   download and offline use"); asserts dim 384, ‖v‖≈1 (the
 *   normalize-vs-`normalization` trap, findings §6.1), the e5
 *   query/passage prefix alignment, and related>unrelated ranking for
 *   three crafted pairs including a Spanish-query pair (the model is
 *   multilingual e5, so cross-lingual recall is a shipped promise).
 * - milvus-lite is spawned for real via MilvusLauncher (uvx, pinned
 *   3.2.2; G13 warm-cache assumed) into a tmp dbPath, and the
 *   ObsidianMemService runs its genuine provisioning pass over real
 *   node:fs tmp dirs: ensureCollection, the real-embedder
 *   IndexerManager full run, hybrid search through the service seam,
 *   write-through via applyWrite, archived purge, dim-drift
 *   {needsRebuild} answered against the live server, then
 *   count/drop/dispose with the child pid verified gone.
 *
 * Collection gating lives in vitest.config.ts: `*.live.test.ts` files
 * are only collected with RUN_LIVE=1, so `pnpm test` stays green
 * offline. The describeLive mirror below is the guard for direct
 * `vitest run <this file>` invocations. Per-test timeout 180 s (G13).
 * @module dsh-plugin-obsidian-mem/service/tests/integration/live-pipeline
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MilvusClient } from '@zilliz/milvus2-sdk-node'

import {
  DEFAULT_MODEL_ID,
  MILVUS_COLLECTION,
  VECTOR_DIM_DEFAULT,
  chunkMarkdown,
  modelCacheDir,
  parseNote,
} from '../../../core/lib/index.js'
import { createEmbedder } from '../../src/embedder.ts'
import { IndexerManager } from '../../src/indexer.ts'
import type { IndexWriter } from '../../src/indexer.ts'
import { MilvusLauncher, MILVUS_LITE_VERSION } from '../../src/milvus/launcher.ts'
import { dropCollection, ensureCollection, rebuildCollection } from '../../src/milvus/schema.ts'
import { ObsidianMemService } from '../../src/service.ts'
import type { IndexerLike, MilvusLauncherLike } from '../../src/service.ts'

const describeLive = process.env.RUN_LIVE === '1' ? describe : describe.skip

// One warm model session backs both describes: the embedder describe warms
// it first, the service pipeline reuses the already-loaded singleton.
const liveEmbedder = createEmbedder({
  modelId: DEFAULT_MODEL_ID,
  vectorDim: VECTOR_DIM_DEFAULT,
  // The warm local cache (G13): never the tmp home, or every run would
  // re-download the 135 MB model.
  cacheDir: modelCacheDir(osHomedir()),
})

/** Cosine over unit vectors: the ranking sanity metric everywhere here. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] as number) * (b[index] as number)
  }
  return dot
}

describeLive('live embedder: multilingual-e5-small through the real pipeline (RUN_LIVE=1)', () => {
  it('emits 384-d unit vectors for passages and queries', async () => {
    const [passage, query] = await Promise.all([
      liveEmbedder.embedPassages(['the daemon leaked file handles on every reload']),
      liveEmbedder.embedQuery('why does the process grow over time?'),
    ])

    expect(passage[0]).toHaveLength(VECTOR_DIM_DEFAULT)
    expect(query).toHaveLength(VECTOR_DIM_DEFAULT)
    for (const vector of [passage[0]!, query]) {
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      // The silent-normalization failure mode lands at ~4.5 (findings §6.1).
      expect(Math.abs(norm - 1)).toBeLessThan(1e-3)
    }
  })

  it('ranks related pairs above unrelated for EN, ES-query, and paraphrase probes', async () => {
    const [leakVector, keepaliveVector, gardenVector] = await liveEmbedder.embedPassages([
      '## Memory leak\nThe long-running daemon leaked file handles on every reload; '
        + 'closing them in a finally block fixed the growth.',
      '## gRPC keepalive\nmilvus-lite answered the SDK keepalive pings with GOAWAY '
        + 'ENHANCE_YOUR_CALM because of excess pings.',
      '## Garden soil\nPetrichor is the earthy scent produced when rain falls on dry soil.',
    ])

    const probes: Array<{ label: string; query: string; related: number[]; unrelated: number[] }> = [
      {
        label: 'english explicit',
        query: 'What causes the long-running process to grow and leak file handles?',
        related: leakVector!,
        unrelated: gardenVector!,
      },
      {
        label: 'spanish query vs english passage',
        query: '¿Cómo se soluciona una fuga de memoria en un proceso de larga duración?',
        related: leakVector!,
        unrelated: gardenVector!,
      },
      {
        label: 'paraphrase without term overlap',
        query: 'Why did the server tear down my channel with ENHANCE_YOUR_CALM?',
        related: keepaliveVector!,
        unrelated: gardenVector!,
      },
    ]

    for (const probe of probes) {
      const queryVector = await liveEmbedder.embedQuery(probe.query)
      const relatedScore = cosine(queryVector, probe.related)
      const unrelatedScore = cosine(queryVector, probe.unrelated)
      expect(relatedScore, probe.label).toBeGreaterThan(unrelatedScore + 0.05)
    }
  })

  it('aligns query: and passage: prefixes for the same text', async () => {
    const text = 'opalescent greenhouse misting loop'
    const [queryVector, passageVector] = await Promise.all([
      liveEmbedder.embedQuery(text),
      liveEmbedder.embedPassages([text]).then((rows) => rows[0]!),
    ])

    // e5's dual prefixes must keep same-text queries and passages highly
    // aligned (empirically ~0.95+); drift here means the prefixes broke.
    expect(cosine(queryVector, passageVector)).toBeGreaterThan(0.85)
  })
})

// ---------------------------------------------------------------------------
// Full pipeline fixtures. Real files on disk: six notes (two archived), a
// reserved .INTENTS.md at the vault root, reserved/dotfile/non-md decoys
// inside markdown/, frontmatter variety incl. a keywords: override.

const ACTIVE_NOTES = {
  'markdown/memory-leak.md': [
    '---',
    'index_title: Memory leak in the daemon',
    'index_description: How the long-running daemon leaked file handles and how it was fixed.',
    'type: domain',
    'archive: false',
    'created: 2026-09-02',
    'updated: 2026-10-11',
    'read_count: 3',
    '---',
    '# Memory leak in the daemon',
    '',
    '## Symptoms',
    'The daemon grew by 40 MB a day and the open-file count climbed until',
    'the process hit its ulimit and aborted.',
    '',
    '## Fix',
    'File handles from the metric exporter were never closed. Wrapping the',
    'exporter stream in a finally block released them deterministically.',
    '',
  ].join('\n'),
  'markdown/milvus-keepalive.md': [
    '---',
    'index_title: milvus-lite keepalive GOAWAY',
    'index_description: gRPC keepalive pings make milvus-lite answer GOAWAY ENHANCE_YOUR_CALM.',
    'type: mem-plugin',
    'archive: false',
    'created: 2026-10-20',
    'updated: 2026-11-01',
    'read_count: 1',
    '---',
    '# milvus-lite keepalive GOAWAY',
    '',
    'The pure-Python gRPC server enforces an HTTP/2 keepalive policy and',
    'rejects excess pings with GOAWAY ENHANCE_YOUR_CALM. Suppress them:',
    '',
    '```ts',
    "const channelOptions = { 'grpc.keepalive_time_ms': 86_400_000 }",
    '```',
    '',
  ].join('\n'),
  'markdown/petrichor-garden.md': [
    '---',
    'index_title: Petrichor in the garden log',
    'index_description: What petrichor is and which soil notes mention it.',
    'type: global',
    'archive: false',
    'created: 2026-08-14',
    'updated: 2026-08-14',
    'read_count: 0',
    '---',
    '# Petrichor in the garden log',
    '',
    'Petrichor is the earthy scent produced when rain falls on dry soil;',
    'the word was coined in 1964 from the Greek for "stone" and the blood',
    'of the giants from Greek myth.',
    '',
  ].join('\n'),
  'markdown/http-cache.md': [
    '---',
    'index_title: HTTP cache headers',
    'index_description: s-maxage and stale-while-revalidate usage for the CDN edge.',
    'type: reference',
    'archive: false',
    'created: 2026-07-01',
    'updated: 2026-09-15',
    'read_count: 7',
    'keywords:',
    '  - cache invalidation',
    '---',
    '# HTTP cache headers',
    '',
    'The edge honors `s-maxage` for shared caches and serves stale content',
    'while revalidating when `stale-while-revalidate` is set.',
    '',
  ].join('\n'),
} as const

const ARCHIVED_NOTES = {
  'markdown/deprecated-login.md': [
    '---',
    'index_title: Deprecated login flow',
    'index_description: The retired password-only login; kept for audit only.',
    'type: global',
    'archive: true',
    'created: 2025-11-03',
    'updated: 2026-01-22',
    'read_count: 0',
    '---',
    '# Deprecated login flow',
    '',
    'The legacy flow accepted password-only logins before the 2FA rollout.',
    '',
  ].join('\n'),
  'markdown/old-billing.md': [
    '---',
    'index_title: Old billing notes',
    'index_description: Retired billing notes; centavo rounding details.',
    'type: global',
    'archive: true',
    'created: 2025-05-19',
    'updated: 2025-06-02',
    'read_count: 0',
    '---',
    '# Old billing notes',
    '',
    'Prices were stored in centavo units and rounded half-up at checkout.',
    '',
  ].join('\n'),
} as const

// Decoys that must never reach the index: reserved vault-root protocol
// file, reserved *_history.md, dotfile, non-markdown.
const NEVER_INDEXED = {
  // vault-root-joined keys below
  '.INTENTS.md': '# Intents\n\nintentmarker sections live here for the recall router.\n',
  'markdown/billing_history.md': '# Billing history\n\nobol-era invoices were archived.\n',
  'markdown/.draft-note.md': '# Draft\n\nobol in a dotfile too.\n',
  'markdown/notes.txt': 'obol inside a non-markdown file.\n',
} as const

function seededNotes(): Record<string, string> {
  return {
    ...ACTIVE_NOTES,
    ...ARCHIVED_NOTES,
    'markdown/billing_history.md': NEVER_INDEXED['markdown/billing_history.md'],
    'markdown/.draft-note.md': NEVER_INDEXED['markdown/.draft-note.md'],
    'markdown/notes.txt': NEVER_INDEXED['markdown/notes.txt'],
  }
}

/** Chunks the real chunker will produce for one indexed note. */
function chunkCount(relPath: string, text: string): number {
  return chunkMarkdown({ source_path: relPath, text }).length
}

/** Fake ctx: the Service base plus the seam's own consumption surface. */
function fakeCtx() {
  const ctx = {
    reflect: { provide: () => () => undefined },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    effect: (execute: () => () => unknown) => {
      const dispose = execute()
      return () => {
        dispose()
      }
    },
    get: () => undefined,
  }
  return ctx as unknown as Context
}

function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describeLive('live pipeline: real e5 embedder + uvx milvus-lite through the service seam (RUN_LIVE=1)', () => {
  // One spawned milvus for the whole file (wall-time discipline): the
  // beforeAll below pays the uvx spawn once.
  let homeDir = ''
  let vaultDir = ''
  let dbDir = ''
  let service: ObsidianMemService | null = null
  let client: MilvusClient | null = null
  let launcherRef: MilvusLauncher | null = null
  let indexerRef: IndexerManager | null = null
  let expectedChunks = 0

  async function rowCount(): Promise<number> {
    const response = await client!.count({ collection_name: MILVUS_COLLECTION })
    return Number(response.data ?? 0)
  }

  beforeAll(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'mem-live-home-'))
    vaultDir = mkdtempSync(join(tmpdir(), 'mem-live-vault-'))
    dbDir = mkdtempSync(join(tmpdir(), 'mem-live-db-'))

    mkdirSync(join(vaultDir, 'markdown'), { recursive: true })
    for (const [rel, text] of Object.entries(seededNotes())) {
      writeFileSync(join(vaultDir, rel), text, 'utf8')
    }
    writeFileSync(join(vaultDir, '.INTENTS.md'), NEVER_INDEXED['.INTENTS.md']!, 'utf8')

    expectedChunks = Object.entries(ACTIVE_NOTES)
      .reduce((sum, [rel, text]) => sum + chunkCount(rel, text), 0)

    const serviceInstance = new ObsidianMemService(
      fakeCtx(),
      {
        vaults: [{ path: vaultDir, mode: 'shared' }],
        milvus: { dbPath: dbDir },
      },
      {
        // tmp HOME: every $HOME-anchored default lands in the sandbox;
        // only the model cache is deliberately the warm real one.
        homedir: () => homeDir,
        embedder: liveEmbedder,
        // The uv cache is already warm (G13); skip the detached uvx warm.
        prewarm: () => undefined,
        launcherFactory: (options): MilvusLauncherLike => {
          const launcher = new MilvusLauncher(options)
          launcherRef = launcher
          return launcher
        },
        indexerFactory: (options): IndexerLike => {
          const manager = new IndexerManager(options)
          indexerRef = manager
          return manager
        },
        clientFactory: async (address) => {
          const { readyMilvusClient } = await import('../../src/milvus/client.ts')
          const ready = await readyMilvusClient(address)
          client = ready
          return ready
        },
      },
    )
    service = serviceInstance

    const notice = await serviceInstance.ensureMemoryAccess()

    // A configured shared vault means no default-vault notice, and the
    // background full-scan must land every active note's chunks.
    expect(notice).toBeUndefined()
    expect(serviceInstance.status().state).toBe('ready')
    expect(serviceInstance.status().milvus.version).toBe(`milvus_lite-${MILVUS_LITE_VERSION}`)
    await vi.waitFor(async () => {
      expect(await rowCount()).toBe(expectedChunks)
    }, { timeout: 180_000, interval: 1_000 })
  }, 300_000)

  afterAll(async () => {
    if (service !== null) {
      // teardown() is idempotent; the drop/dispose test may have run.
      await service.stop().catch(() => undefined)
    }
    const pid = launcherRef?.ownedChild?.pid
    if (pid !== undefined && childAlive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
    for (const dir of [homeDir, vaultDir, dbDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full run indexes active notes only: archived, reserved, dotfile, and non-md stay out', async () => {
    expect(await rowCount()).toBe(expectedChunks)

    // The keyword-only probe: 'petrichor' exists in exactly one live note.
    const hits = await service!.search({ query: 'petrichor', topK: 5 })
    expect(hits[0]?.source_path).toBe('markdown/petrichor-garden.md')

    // Archived-only tokens: hybrid search always answers nearest rows,
    // so the exclusion is proven by absence of the archived paths.
    const archivedPaths = Object.keys(ARCHIVED_NOTES)
    for (const token of ['centavo', 'password-only logins']) {
      const archivedHits = await service!.search({ query: token, topK: 10 })
      for (const path of archivedPaths) {
        expect(archivedHits.map((hit) => hit.source_path), `${token} -> ${path}`).not.toContain(path)
      }
    }

    // Reserved/dotfile/non-markdown decoys never enter the index.
    for (const token of ['obol', 'intentmarker']) {
      const decoyHits = await service!.search({ query: token, topK: 10 })
      expect(decoyHits.map((hit) => hit.source_path), token).not.toContain('markdown/billing_history.md')
      expect(decoyHits.map((hit) => hit.source_path), token).not.toContain('markdown/.draft-note.md')
    }

    const state = JSON.parse(
      readFileSync(join(vaultDir, 'metadata', 'obsidian-mem-state.json'), 'utf8'),
    ) as { files: Record<string, { chunkIds: number[] }>; modelId: string; vectorDim: number }
    // Every candidate note has a state entry (archived ones with empty
    // chunkIds, the diff bookkeeping), while reserved/dotfile/non-md
    // decoys never appear at all.
    expect(Object.keys(state.files).sort()).toEqual(
      [...Object.keys(ACTIVE_NOTES), ...Object.keys(ARCHIVED_NOTES)].sort(),
    )
    for (const archived of Object.keys(ARCHIVED_NOTES)) {
      expect(state.files[archived]!.chunkIds, archived).toEqual([])
    }
    expect(state.modelId).toBe(DEFAULT_MODEL_ID)
    expect(state.vectorDim).toBe(VECTOR_DIM_DEFAULT)
  }, 180_000)

  it('hybrid search: Spanish query ranks the english leak note first (semantic-only route)', async () => {
    const hits = await service!.search({
      query: '¿Cómo se soluciona una fuga de memoria en un proceso de larga duración?',
      topK: 5,
    })

    expect(hits[0]?.source_path).toBe('markdown/memory-leak.md')
  }, 180_000)

  it('hybrid search: paraphrase query ranks the keepalive note first (mixed routes)', async () => {
    const hits = await service!.search({
      query: 'Why did the server tear down my gRPC channel with ENHANCE_YOUR_CALM?',
      topK: 5,
    })

    expect(hits[0]?.source_path).toBe('markdown/milvus-keepalive.md')
  }, 180_000)

  it('scalar filters: ARRAY trigger extension, wake keywords, and scope partition routing', async () => {
    // ARRAY_CONTAINS on trigger_extensions: only the ts-fenced note qualifies.
    const extHits = await service!.search({ query: 'keepalive ping channel', ext: '.ts', topK: 10 })
    expect(extHits.length).toBeGreaterThan(0)
    expect(new Set(extHits.map((hit) => hit.source_path))).toEqual(
      new Set(['markdown/milvus-keepalive.md']),
    )

    // ARRAY_CONTAINS_ANY on wake_keywords: the keywords: frontmatter
    // override reached the stored array for the cache note only.
    const keywordHits = await service!.search({
      query: 'edge cache behaviour',
      wakeKeywords: ['cache invalidation'],
      topK: 10,
    })
    expect(keywordHits.length).toBeGreaterThan(0)
    expect(new Set(keywordHits.map((hit) => hit.source_path))).toEqual(
      new Set(['markdown/http-cache.md']),
    )

    // Scope partition: domain scope answers with the leak note alone.
    const domainHits = await service!.search({ query: 'leak', scopes: ['domain'], topK: 10 })
    expect(domainHits.length).toBeGreaterThan(0)
    for (const hit of domainHits) {
      expect(hit.scope).toBe('domain')
      expect(hit.source_path).toBe('markdown/memory-leak.md')
    }

    // The result rows carry the registry-resolved vault mode.
    expect(domainHits[0]!.mode).toBe('shared')
  }, 180_000)

  it('write-through: applyWrite makes fresh text searchable without a manual reindex', async () => {
    const notePath = join(vaultDir, 'markdown', 'petrichor-garden.md')
    const note = parseNote(readFileSync(notePath, 'utf8'))
    const updatedBody = `${note.body}\n## Reblooming\n\nThe greenhouse now runs a zephyrline misting loop.\n`

    const result = await service!.applyWrite(notePath, note.meta, updatedBody)
    expect(result.created).toBe(false)
    expect(result.relPath).toBe(join('markdown', 'petrichor-garden.md'))

    // Strong consistency + the write-through hook: the fresh token must
    // answer without waiting on the watcher or the stat sweep.
    const hits = await service!.search({ query: 'zephyrline misting loop', topK: 5 })
    expect(hits[0]?.source_path).toBe('markdown/petrichor-garden.md')
    expect(hits[0]?.chunk_text).toContain('zephyrline')

    const state = JSON.parse(
      readFileSync(join(vaultDir, 'metadata', 'obsidian-mem-state.json'), 'utf8'),
    ) as { files: Record<string, { chunkIds: number[] }> }
    expect(state.files['markdown/petrichor-garden.md']!.chunkIds.length).toBeGreaterThan(1)
  }, 180_000)

  it('delete-archived: archiving a note purges its rows and the count drops', async () => {
    const before = await rowCount()
    const cacheChunks = chunkCount('markdown/http-cache.md', ACTIVE_NOTES['markdown/http-cache.md'])
    const notePath = join(vaultDir, 'markdown', 'http-cache.md')
    const note = parseNote(readFileSync(notePath, 'utf8'))

    await service!.applyWrite(notePath, { ...note.meta, archive: true }, note.body)

    await vi.waitFor(async () => {
      expect(await rowCount()).toBe(before - cacheChunks)
    }, { timeout: 60_000, interval: 500 })

    const hits = await service!.search({ query: 's-maxage stale-while-revalidate', topK: 10 })
    expect(hits.map((hit) => hit.source_path)).not.toContain('markdown/http-cache.md')
  }, 180_000)

  it('dim drift: ensureCollection reports {needsRebuild} against the live 384-d collection; rebuild + reindex restores', async () => {
    // The exact probe provision() runs: a configured 256-d column cannot
    // be satisfied by the stored 384-d one, and the live server answers.
    const drift = await ensureCollection(client!, { dim: 256 })
    expect(drift).toEqual({ created: false, needsRebuild: true, storedDim: VECTOR_DIM_DEFAULT })

    // The provision() remedy: rebuild at the wanted width, drop the vault
    // state files (service dropVaultStateFiles), and let a freshly built
    // manager (service restartIndexer) force the full re-embed.
    const rebuilt = await rebuildCollection(client!, { dim: VECTOR_DIM_DEFAULT })
    expect(rebuilt).toEqual({ created: true, needsRebuild: false, storedDim: VECTOR_DIM_DEFAULT })
    expect(await rowCount()).toBe(0)

    rmSync(join(vaultDir, 'metadata', 'obsidian-mem-state.json'), { force: true })
    const fresh = new IndexerManager({
      vaults: [{ path: vaultDir, mode: 'shared' }],
      embedder: liveEmbedder,
      writer: client as unknown as IndexWriter,
      watchFactory: () => null,
      log: () => undefined,
    })
    await fresh.reindexAll()

    // The two archived notes stay out of the restored count; the
    // write-through edit to the garden note is part of the baseline.
    const expectedAfterArchive = expectedChunks
      + chunkCount('markdown/petrichor-garden.md', readFileSync(join(vaultDir, 'markdown', 'petrichor-garden.md'), 'utf8'))
      - chunkCount('markdown/petrichor-garden.md', ACTIVE_NOTES['markdown/petrichor-garden.md'])
      - chunkCount('markdown/http-cache.md', ACTIVE_NOTES['markdown/http-cache.md'])
    expect(await rowCount()).toBe(expectedAfterArchive)
    // The service's own (still-live) manager observed the vault work it
    // did before the rebuild: its counters stay the progress source the
    // status card reads.
    expect(indexerRef).not.toBeNull()
    expect(indexerRef!.progress().indexed).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('count, drop, dispose: collection removed, seam stopped, child pid gone', async () => {
    expect(await rowCount()).toBeGreaterThan(0)

    await dropCollection(client!, MILVUS_COLLECTION)
    const exists = await client!.hasCollection({ collection_name: MILVUS_COLLECTION })
    expect(exists.value).toBe(false)

    const pid = launcherRef!.ownedChild?.pid
    expect(pid).toBeTypeOf('number')

    await service!.stop()

    await vi.waitFor(() => expect(childAlive(pid!)).toBe(false), { timeout: 20_000 })
    expect(launcherRef!.ownedChild).toBeNull()
  }, 180_000)
})
