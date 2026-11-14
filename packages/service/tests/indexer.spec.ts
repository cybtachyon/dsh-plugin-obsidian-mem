import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { GLOBAL_MEMORY_FILE_DEFAULT, MILVUS_ARRAY_CAPACITIES, MILVUS_FIELDS, MILVUS_SCALAR_MAX_LENGTHS } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import type { Embedder } from '../src/embedder.ts'
import {
  IndexerManager,
  INDEX_STATE_VERSION,
  MAX_CHUNKS_PER_FILE,
  MAX_FILES_PER_VAULT,
  nodeIndexerFs,
  STATE_FILE_NAME,
  VaultIndexer,
  WATCH_DEBOUNCE_MS,
} from '../src/indexer.ts'
import { LlmRefiner } from '../src/llm-refine.ts'
import type {
  IndexChunkRow,
  IndexDirEntry,
  IndexerFs,
  IndexWriter,
  LlmFetch,
  WatchFactory,
  WatchListener,
} from '../src/indexer.ts'

/**
 * Indexer spec for TASK-023 with fakes only: an in-memory IndexerFs, a
 * recording writer capturing every insert/delete payload, fakeEmbedder,
 * and injected watch factories. Covers the state-file diff (first run,
 * no-op, changed, removed), archived purge, offline retry, model/dim
 * swap migration, watcher debounce with fake timers, the polling
 * fallback, progress counters, and the LLM merge/fallback/circuit.
 * TASK-005 re-rooted every seed and key to the vault root: the specs pin
 * root-relative keys, the dot-dir skip, the version-1 purge, and the
 * watcher's self-noise filter.
 */

class MemFs implements IndexerFs {
  readonly files = new Map<string, { content: string; mtimeMs: number }>()
  readonly renames: Array<{ from: string; to: string }> = []

  add(absolutePath: string, content: string, mtimeMs = 1000): void {
    this.files.set(absolutePath, { content, mtimeMs })
  }

  remove(absolutePath: string): void {
    this.files.delete(absolutePath)
  }

  listDirectory(path: string): IndexDirEntry[] | null {
    const prefix = `${path}/`
    const entries = new Map<string, IndexDirEntry>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) {
        continue
      }
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        entries.set(rest, { name: rest, directory: false })
      } else {
        const dir = rest.slice(0, slash)
        entries.set(dir, { name: dir, directory: true })
      }
    }
    return entries.size === 0 ? null : [...entries.values()]
  }

  readFile(path: string): string | null {
    return this.files.get(path)?.content ?? null
  }

  writeFile(path: string, contents: string): void {
    this.files.set(path, { content: contents, mtimeMs: 0 })
  }

  rename(from: string, to: string): void {
    this.renames.push({ from, to })
    const file = this.files.get(from)
    this.files.delete(from)
    if (file !== undefined) {
      this.files.set(to, file)
    }
  }

  stat(path: string): { mtimeMs: number } | null {
    const file = this.files.get(path)
    return file === undefined ? null : { mtimeMs: file.mtimeMs }
  }

  mkdirp(): void {
    // MemFs derives directories from file paths; nothing to create.
  }

  state(vaultPath = '/vault'): unknown {
    const raw = this.files.get(`${vaultPath}/.obsidian-mem/metadata/${STATE_FILE_NAME}`)?.content
    return raw === undefined ? null : JSON.parse(raw) as unknown
  }
}

interface WriterCall {
  method: 'insert' | 'delete'
  request: { collection_name: string; data?: IndexChunkRow[]; ids?: number[] }
}

interface StubWriterOptions {
  failInsertTimes?: number
  failDeleteTimes?: number
}

function stubWriter(options: StubWriterOptions = {}) {
  const calls: WriterCall[] = []
  let insertFailures = options.failInsertTimes ?? 0
  let deleteFailures = options.failDeleteTimes ?? 0
  const ok = { status: { error_code: 'Success', code: 0, reason: '' } }
  const writer: IndexWriter = {
    async insert(request) {
      calls.push({ method: 'insert', request })
      if (insertFailures > 0) {
        insertFailures -= 1
        throw new Error('milvus insert: 14 UNAVAILABLE')
      }
      return ok
    },
    async delete(request) {
      calls.push({ method: 'delete', request })
      if (deleteFailures > 0) {
        deleteFailures -= 1
        throw new Error('milvus delete: 14 UNAVAILABLE')
      }
      return ok
    },
  }
  return { writer, calls }
}

const ALPHA_NOTE = [
  '---',
  'index_title: Alpha',
  'index_description: alpha note',
  'type: domain',
  'archive: false',
  '---',
  '# Alpha',
  '',
  '**Rate limiter** uses a token bucket. How to debug counters.',
  '',
].join('\n')

const BETA_NOTE = [
  '---',
  'index_title: Beta',
  'index_description: beta note',
  'type: proj-x',
  'archive: false',
  '---',
  '## Beta flags',
  '',
  '```ts',
  'const flag = true',
  '```',
  '',
].join('\n')

function seedVault(memFs: MemFs): void {
  memFs.add('/vault/a.md', ALPHA_NOTE, 1111)
  memFs.add('/vault/sub/b.md', BETA_NOTE, 2222)
}

interface IndexerFixture {
  fs: MemFs
  writer: ReturnType<typeof stubWriter>
  indexer: VaultIndexer
  listeners: WatchListener[]
}

function makeFixture(overrides: {
  embedder?: Embedder
  watchFactory?: WatchFactory
  writerOptions?: StubWriterOptions
  llm?: { enabled: boolean; baseUrl: string; model: string; apiKeyEnv?: string }
  fetch?: LlmFetch
  env?: Record<string, string | undefined>
} = {}): IndexerFixture {
  const fs = new MemFs()
  seedVault(fs)
  const writer = stubWriter(overrides.writerOptions)
  const listeners: WatchListener[] = []
  const indexer = new VaultIndexer({
    vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    embedder: overrides.embedder ?? fakeEmbedder({ vectorDim: 8 }),
    writer: writer.writer,
    fs,
    watchFactory: overrides.watchFactory
      ?? ((_path, listener) => {
        listeners.push(listener)
        return { close(): void { /* fake watch: nothing to release */ } }
      }),
    log: () => undefined,
    ...(overrides.llm !== undefined ? { llm: overrides.llm } : {}),
    ...(overrides.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
  })
  return { fs, writer, indexer, listeners }
}

// Same fixture with the stat sweep re-pointed (or disabled with 0), which the
// sweep-configuration tests need instead of the 30 s default.
function makeFixtureShortPoll(pollIntervalMs: number): IndexerFixture {
  const fs = new MemFs()
  seedVault(fs)
  const writer = stubWriter()
  const indexer = new VaultIndexer({
    vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    embedder: fakeEmbedder({ vectorDim: 8 }),
    writer: writer.writer,
    fs,
    watchFactory: () => null,
    pollIntervalMs,
    log: () => undefined,
  })
  return { fs, writer, indexer, listeners: [] }
}

// Drain the microtask chain a fire-and-forget start()/watcher flush runs
// through; no timers are involved inside the pipeline itself.
async function settle(): Promise<void> {
  for (let round = 0; round < 400; round += 1) {
    await Promise.resolve()
  }
}

function filesOf(state: unknown): Record<string, { contentHash: string; mtimeMs: number; chunkIds: number[] }> {
  return (state as { files?: Record<string, { contentHash: string; mtimeMs: number; chunkIds: number[] }> })
    ?.files ?? {}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reindex first run', () => {
  it('indexes candidate notes, skips dotfiles/reserved/non-md, and writes state atomically', async () => {
    const { fs, writer, indexer } = makeFixture()
    fs.add('/vault/.hidden.md', '# hidden\n', 1)
    fs.add('/vault/DREAMS.md', '# dreams\n', 1)
    fs.add('/vault/old_history.md', '# history\n', 1)
    fs.add('/vault/notes.txt', 'not markdown\n', 1)
    // Dot dirs are out of the index wholesale: the plugin sidecars,
    // Obsidian's own config, and any other hidden directory.
    fs.add('/vault/.obsidian-mem/metadata/sidecar.md', '# sidecar\n', 1)
    fs.add('/vault/.obsidian/workspace.md', '# obsidian ui\n', 1)
    fs.add('/vault/.hidden-dir/secret.md', '# hidden dir\n', 1)
    fs.add('/vault/arch.md', [
      '---', 'archive: true', '---', '# Archived', '',
    ].join('\n'), 1)

    const summary = await indexer.reindex()

    const inserts = writer.calls.filter((call) => call.method === 'insert')
    expect(inserts).toHaveLength(2)
    expect(writer.calls.filter((call) => call.method === 'delete')).toHaveLength(0)
    expect(summary.indexed).toBe(2)

    const rows = inserts[0]!.request.data!
    expect(inserts[0]!.request.collection_name).toBe('obsidian_mem')
    expect(rows[0]).toMatchObject({
      [MILVUS_FIELDS.sourcePath]: 'a.md',
      [MILVUS_FIELDS.vault]: '/vault',
      [MILVUS_FIELDS.scope]: 'domain',
      [MILVUS_FIELDS.updatedAt]: 1111,
    })
    expect(Number.isSafeInteger(rows[0]![MILVUS_FIELDS.chunkId])).toBe(true)
    expect((rows[0]![MILVUS_FIELDS.denseVector] as number[]).length).toBe(8)
    expect(rows[0]![MILVUS_FIELDS.wakeKeywords]).toContain('rate limiter')
    expect(rows[0]).not.toHaveProperty(MILVUS_FIELDS.sparseVector)

    const betaRows = inserts[1]!.request.data!
    expect(betaRows[0]).toMatchObject({ [MILVUS_FIELDS.scope]: 'proj-x' })
    expect(betaRows[0]![MILVUS_FIELDS.triggerExtensions]).toEqual(['.ts'])

    const state = filesOf(fs.state())
    expect(Object.keys(state).sort()).toEqual(['a.md', 'arch.md', 'sub/b.md'])
    // Root-relative keys with no leading slash; nothing from a dot dir.
    expect(Object.keys(state).some((key) => key.startsWith('.'))).toBe(false)
    expect(state['arch.md']!.chunkIds).toEqual([])
    expect(fs.renames).toContainEqual({
      from: `/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}.tmp`,
      to: `/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`,
    })
    expect(indexer.progress.indexed).toBe(2)
  })

  it('is a no-op on a second unchanged run', async () => {
    const { writer, indexer } = makeFixture()
    await indexer.reindex()
    const baseline = writer.calls.length

    const summary = await indexer.reindex()

    expect(writer.calls.length).toBe(baseline)
    expect(summary.indexed).toBe(0)
    expect(summary.errors).toBe(0)
  })
})

describe('state diff', () => {
  it('re-embeds a changed file: deletes its old chunk ids, then inserts', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const oldIds = filesOf(fs.state())['a.md']!.chunkIds
    const before = writer.calls.length
    fs.add('/vault/a.md', `${ALPHA_NOTE}\nNew insight about **billing**.\n`, 3333)

    await indexer.reindex()

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
    expect(newCalls[0]!.request.ids).toEqual(oldIds)
    const rows = newCalls[1]!.request.data!
    expect(rows.some((row) => (row[MILVUS_FIELDS.wakeKeywords] as string[]).includes('billing'))).toBe(true)
    expect(filesOf(fs.state())['a.md']!.mtimeMs).toBe(3333)
  })

  it('deletes chunks of a removed file and drops its state entry', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const betaIds = filesOf(fs.state())['sub/b.md']!.chunkIds
    fs.remove('/vault/sub/b.md')
    const before = writer.calls.length

    await indexer.reindex()

    const deletes = writer.calls.slice(before).filter((call) => call.method === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.request.ids).toEqual(betaIds)
    expect(filesOf(fs.state())['sub/b.md']).toBeUndefined()
  })

  it('purges chunks of a note archived after it was indexed', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const alphaIds = filesOf(fs.state())['a.md']!.chunkIds
    fs.add('/vault/a.md', ALPHA_NOTE.replace('archive: false', 'archive: true'), 4444)
    const before = writer.calls.length

    await indexer.reindex()

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete'])
    expect(newCalls[0]!.request.ids).toEqual(alphaIds)
    expect(filesOf(fs.state())['a.md']!.chunkIds).toEqual([])
  })
})

describe('offline and migration', () => {
  it('keeps the failed file dirty when Milvus is offline and retries next run', async () => {
    const { fs, writer, indexer } = makeFixture({ writerOptions: { failInsertTimes: 1 } })

    await indexer.reindex()

    expect(indexer.progress.errors).toBe(1)
    // a.md (first alphabetically) failed; its state entry was not written.
    expect(filesOf(fs.state())['a.md']).toBeUndefined()
    const failedCalls = writer.calls.length

    await indexer.reindex()

    expect(filesOf(fs.state())['a.md']).toBeDefined()
    expect(writer.calls.length).toBeGreaterThan(failedCalls)
  })

  it('model swap: deletes every old-model chunk id and re-inserts fresh ids', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const oldAlphaIds = filesOf(fs.state())['a.md']!.chunkIds
    const before = writer.calls.length

    const swapped = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ modelId: 'other-model', vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })
    await swapped.reindex()

    const newCalls = writer.calls.slice(before)
    const deletes = newCalls.filter((call) => call.method === 'delete')
    expect(deletes[0]!.request.ids).toEqual(oldAlphaIds)
    const newAlphaIds = filesOf(fs.state())['a.md']!.chunkIds
    expect(newAlphaIds).not.toEqual(oldAlphaIds)
    expect((fs.state() as { modelId: string }).modelId).toBe('other-model')
  })
})

describe('write-through hook', () => {
  it('indexFile re-indexes one changed file by relative or absolute path', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    fs.add('/vault/a.md', `${ALPHA_NOTE}\nUpdated\n`, 5555)
    const before = writer.calls.length

    await indexer.indexFile('/vault/a.md')

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
  })

  it('indexFile on an unknown or removed path is safe', async () => {
    const { fs, indexer } = makeFixture()
    await indexer.reindex()
    const stateBefore = JSON.stringify(fs.state())

    await indexer.indexFile('never-indexed.md')
    await indexer.indexFile('notes/outside.md')

    expect(JSON.stringify(fs.state())).toBe(stateBefore)
  })
})

describe('watcher triggers', () => {
  it('debounces events 1500 ms and indexes only the changed file once', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer, listeners } = makeFixture()
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nWatcher edit\n`, 6666)
    const listener = listeners[0]!
    listener('a.md')
    listener('a.md')
    listener('sub/../b.tmp')

    vi.advanceTimersByTime(1499)
    await settle()
    expect(writer.calls.length).toBe(baseline)

    vi.advanceTimersByTime(1)
    await settle()
    const newCalls = writer.calls.slice(baseline)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
    indexer.stop()
  })

  it('an unchanged file touched by the watcher costs no Milvus calls', async () => {
    vi.useFakeTimers()
    const { writer, indexer, listeners } = makeFixture()
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    listeners[0]!('a.md')
    vi.advanceTimersByTime(1500)
    await settle()

    expect(writer.calls.length).toBe(baseline)
    indexer.stop()
  })

  // The watcher root is the vault root, so the indexer's own state saves
  // under `.obsidian-mem/metadata/` fire watch events at it. The dot rule
  // in normalizeRel must drop them before they dirty anything, or every
  // reindex would schedule the next one.
  it('never dirties itself on watch events for .obsidian-mem sidecar writes', async () => {
    vi.useFakeTimers()
    const { writer, indexer, listeners } = makeFixture()
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    listeners[0]!(`/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`)
    listeners[0]!(`.obsidian-mem/metadata/${STATE_FILE_NAME}.tmp`)
    listeners[0]!(`.obsidian-mem/metadata/${STATE_FILE_NAME}`)
    // A candidate .md name under a dot dir: only the dot rule can stop it.
    listeners[0]!('.obsidian-mem/metadata/scratch.md')
    listeners[0]!('.obsidian/workspace.json')
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS + 1)
    await settle()

    expect(writer.calls.length).toBe(baseline)
    indexer.stop()
  })

  it('falls back to stat polling when the watch factory is unsupported', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer } = makeFixture({ watchFactory: () => null })
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nMissed by the watcher\n`, 7777)

    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(1_500)
    await settle()

    const newCalls = writer.calls.slice(baseline)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
    indexer.stop()
  })
})

describe('LLM refinement', () => {
  const llmConfig = { enabled: true, baseUrl: 'https://llm.test/v1/', model: 'gpt-test', apiKeyEnv: 'MEM_LLM_KEY' }
  // llmNoApiKey: the row with apiKeyEnv absent; exactOptionalPropertyTypes
  // forbids the old `{ ...llmConfig, apiKeyEnv: undefined }` spelling.
  const { apiKeyEnv: _apiKeyEnv, ...llmNoApiKey } = llmConfig

  it('merges LLM wake_keywords and frameworks onto the heuristics', async () => {
    const fetchCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
    const fetchImpl: LlmFetch = async (url, init) => {
      fetchCalls.push({ url, body: init.body, headers: init.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '```json\n{"wake_keywords":["quantum"],"trigger_frameworks":["solidjs"]}\n```',
            },
          }],
        }),
      }
    }
    const { writer, indexer } = makeFixture({
      llm: llmConfig,
      fetch: fetchImpl,
      env: { MEM_LLM_KEY: 'sk-test' },
    })

    await indexer.reindex()

    expect(fetchCalls.length).toBeGreaterThan(0)
    expect(fetchCalls[0]!.url).toBe('https://llm.test/v1/chat/completions')
    expect(fetchCalls[0]!.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(fetchCalls[0]!.body) as { model: string; messages: Array<{ content: string }> }
    expect(body.model).toBe('gpt-test')
    expect(body.messages[0]!.content.length).toBeLessThan(6500)

    const rows = writer.calls.filter((call) => call.method === 'insert').flatMap((call) => call.request.data!)
    const alphaRow = rows.find((row) => row[MILVUS_FIELDS.sourcePath] === 'a.md')!
    expect(alphaRow[MILVUS_FIELDS.wakeKeywords]).toContain('quantum')
    expect(alphaRow[MILVUS_FIELDS.wakeKeywords]).toContain('rate limiter')
    expect(alphaRow[MILVUS_FIELDS.triggerFrameworks]).toContain('solidjs')
  })

  it('defaults the fetch seam to the process-global fetch', async () => {
    // Regression found live 2026-11-13: the service mounts the indexer with
    // config only, so with fetch defaulted to null the enabled pass silently
    // never ran (no merges, no failures).
    vi.stubGlobal('fetch', async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"wake_keywords":["globalfetch"],"trigger_frameworks":[]}' } }],
      }),
    }))
    try {
      const refiner = new LlmRefiner({
        config: { enabled: true, baseUrl: 'https://glob.test/v1', model: 'm' },
      })
      const merged = await refiner.refine('chunk text', {
        wake_keywords: ['base'],
        trigger_extensions: [],
        trigger_frameworks: [],
      })
      expect(refiner.failures).toBe(0)
      expect(merged.wake_keywords).toContain('base')
      expect(merged.wake_keywords).toContain('globalfetch')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes endpoint vocabulary through core legality and re-caps both columns', async () => {
    // The loophole this closes: refine merged endpoint lists WITHOUT the
    // isUsableKeyword gate or capColumn, so a live endpoint could re-add the
    // generic markers and fragments the wake cleanup removed, and overflow
    // the Array columns (wakeKeywords cap 96, triggerFrameworks cap 64).
    const junkWake = [
      'quantum', // legal: must survive
      ' How ', // generic marker + padding: title/mixed forms too
      'HOW TO APPLY',
      'how',
      '2fast',
      '0 of 54',
      'unbalanced (paren',
      'glued—one—dash—fragment',
      `${'x'.repeat(70)}`, // past the element max length
    ]
    const junkFrameworks = Array.from({ length: 70 }, (_unused, index) => `framework-${index}`)
    const fetchImpl: LlmFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ wake_keywords: junkWake, trigger_frameworks: junkFrameworks }),
          },
        }],
      }),
    })
    const { writer, indexer } = makeFixture({
      llm: llmNoApiKey,
      fetch: fetchImpl,
    })

    await indexer.reindex()

    const rows = writer.calls.filter((call) => call.method === 'insert').flatMap((call) => call.request.data!)
    const alphaRow = rows.find((row) => row[MILVUS_FIELDS.sourcePath] === 'a.md')!
    const wake = alphaRow[MILVUS_FIELDS.wakeKeywords] as string[]
    expect(wake).toContain('quantum')
    expect(wake).toContain('rate limiter') // heuristics survive intact
    for (const junk of ['how', 'how to apply', '2fast', '0 of 54', 'unbalanced (paren', 'glued—one—dash—fragment']) {
      expect(wake).not.toContain(junk)
    }
    expect(wake.length).toBeLessThanOrEqual(MILVUS_ARRAY_CAPACITIES.wakeKeywords)
    const frameworks = alphaRow[MILVUS_FIELDS.triggerFrameworks] as string[]
    expect(frameworks.length).toBeLessThanOrEqual(MILVUS_ARRAY_CAPACITIES.triggerFrameworks)
  })

  it('caps the chunk text pasted into the prompt at 6000 chars', async () => {
    const prompts: string[] = []
    const fetchImpl: LlmFetch = async (_url, init) => {
      prompts.push((JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages[0]!.content)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }
    }
    const big = `# Big\n\n${'word '.repeat(3000)}\n`
    const { fs, indexer } = makeFixture({ llm: llmConfig, fetch: fetchImpl, env: { MEM_LLM_KEY: 'k' } })
    fs.add('/vault/big.md', big, 1)

    await indexer.reindex()

    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(6000 + 260)
    }
  })

  it('falls back to heuristics silently on failure and counts llmErrors', async () => {
    const fetchImpl: LlmFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { writer, indexer } = makeFixture({
      llm: llmNoApiKey,
      fetch: fetchImpl,
    })

    await indexer.reindex()

    const rows = writer.calls.filter((call) => call.method === 'insert').flatMap((call) => call.request.data!)
    const alphaRow = rows.find((row) => row[MILVUS_FIELDS.sourcePath] === 'a.md')!
    expect(alphaRow[MILVUS_FIELDS.wakeKeywords]).toContain('rate limiter')
    expect(indexer.progress.llmErrors).toBeGreaterThan(0)
  })

  it('opens the circuit after three consecutive failures', async () => {
    let fetchCount = 0
    const fetchImpl: LlmFetch = async () => {
      fetchCount += 1
      throw new Error('offline')
    }
    const { fs, indexer } = makeFixture({
      llm: llmNoApiKey,
      fetch: fetchImpl,
    })
    fs.add('/vault/c.md', '# Gamma\n\n**gamma** signal.\n', 3)
    fs.add('/vault/d.md', '# Delta\n\n**delta** signal.\n', 4)

    await indexer.reindex()

    expect(fetchCount).toBe(3)
    expect(indexer.progress.llmErrors).toBe(3)
  })

  it('skips the pass when apiKeyEnv names a missing key', async () => {
    let fetchCount = 0
    const fetchImpl: LlmFetch = async () => {
      fetchCount += 1
      return { ok: true, status: 200, json: async () => ({ choices: [] }) }
    }
    const { indexer } = makeFixture({ llm: llmConfig, fetch: fetchImpl, env: {} })

    await indexer.reindex()

    expect(fetchCount).toBe(0)
  })
})

describe('caps and manager', () => {
  it('caps chunks per file at MAX_CHUNKS_PER_FILE', async () => {
    const { fs, writer, indexer } = makeFixture()
    const manySections = Array.from(
      { length: MAX_CHUNKS_PER_FILE + 10 },
      (_, index) => `## Section ${index}\n\nBody ${index}.\n`,
    ).join('\n')
    fs.add('/vault/many.md', manySections, 9)

    await indexer.reindex()

    const rows = writer.calls
      .filter((call) => call.method === 'insert')
      .map((call) => call.request.data!)
      .find((data) => data[0]![MILVUS_FIELDS.sourcePath] === 'many.md')
    expect(rows).toHaveLength(MAX_CHUNKS_PER_FILE)
  })

  // TASK-025 carry-over #3: the vault walk must stop at the cap, and the
  // dropped tail must be the sorted-end files (deterministic, log-named).
  it('caps files per vault at MAX_FILES_PER_VAULT, dropping the sorted tail', async () => {
    const logs: string[] = []
    const fs = new MemFs()
    for (let index = 0; index < MAX_FILES_PER_VAULT + 3; index += 1) {
      const name = `f${String(index).padStart(4, '0')}`
      fs.add(`/vault/${name}.md`, `# ${name}\n\nBody ${index}.\n`, index + 1)
    }
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      watchFactory: () => null,
      log: (message) => logs.push(message),
    })

    const summary = await indexer.reindex()

    expect(summary.indexed).toBe(MAX_FILES_PER_VAULT)
    expect(summary.errors).toBe(0)
    const state = filesOf(fs.state())
    expect(Object.keys(state)).toHaveLength(MAX_FILES_PER_VAULT)
    expect(state['f1999.md']).toBeDefined()
    expect(state['f2000.md']).toBeUndefined()
    expect(state['f2002.md']).toBeUndefined()
    expect(logs.some((line) => line.includes(`exceeds cap ${MAX_FILES_PER_VAULT}`))).toBe(true)
  })

  it('IndexerManager reindexes every vault and aggregates progress', async () => {
    const fs = new MemFs()
    fs.add('/vaults/one/a.md', ALPHA_NOTE, 1)
    fs.add('/vaults/two/b.md', BETA_NOTE, 2)
    const writer = stubWriter()
    const manager = new IndexerManager({
      vaults: [
        { path: '/vaults/one', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
        { path: '/vaults/two', mode: 'read-only', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      ],
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })

    await manager.reindexAll()

    const sources = writer.calls
      .filter((call) => call.method === 'insert')
      .flatMap((call) => (call.request.data ?? []).map((row) => `${row[MILVUS_FIELDS.vault]}#${row[MILVUS_FIELDS.sourcePath]}`))
    expect(sources).toContain('/vaults/one#a.md')
    expect(sources).toContain('/vaults/two#b.md')
    expect(manager.progress().indexed).toBe(2)
    expect(manager.vaultProgress('/vaults/two')).not.toBeNull()

    fs.add('/vaults/one/a.md', `${ALPHA_NOTE}\nWrite-through\n`, 5)
    expect(await manager.indexFile('/vaults/one', 'a.md')).toBe(true)
    expect(await manager.indexFile('/vaults/none', 'a.md')).toBe(false)
  })

  // TASK-025 carry-over #3: the service only ever drives the manager's
  // start/stop pair, so the fan-out (watchers armed, background scans run,
  // watchers closed, queued dirt dropped) is asserted here, not per-vault.
  it('start arms every vault watcher and scan; stop closes watchers and drops queued dirt', async () => {
    vi.useFakeTimers()
    const fs = new MemFs()
    fs.add('/vaults/one/a.md', ALPHA_NOTE, 1)
    fs.add('/vaults/two/b.md', BETA_NOTE, 2)
    const writer = stubWriter()
    const listeners: WatchListener[] = []
    let closedWatches = 0
    const manager = new IndexerManager({
      vaults: [
        { path: '/vaults/one', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
        { path: '/vaults/two', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      ],
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      watchFactory: (_path, listener) => {
        listeners.push(listener)
        return { close(): void { closedWatches += 1 } }
      },
      log: () => undefined,
    })

    manager.start()
    await settle()

    expect(listeners).toHaveLength(2)
    expect(closedWatches).toBe(0)
    expect(manager.progress().indexed).toBe(2)
    expect(manager.vaultProgress('/vaults/two')!.indexed).toBe(1)

    // Dirty two files, then stop before the debounce window closes: the
    // queued work must be dropped, and events after stop must be ignored.
    fs.add('/vaults/one/a.md', `${ALPHA_NOTE}\nedit\n`, 7)
    fs.add('/vaults/two/b.md', `${BETA_NOTE}\nedit\n`, 8)
    listeners[0]!('a.md')
    listeners[1]!('b.md')
    const before = writer.calls.length

    manager.stop()
    listeners[0]!('a.md')
    vi.advanceTimersByTime(2_000)
    await settle()

    expect(writer.calls.length).toBe(before)
    expect(closedWatches).toBe(2)
    expect(manager.progress().pending).toBe(0)
  })
})

describe('stat sweep configuration', () => {
  it('runs the sweep on pollIntervalMs when the caller overrides the default', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer } = makeFixtureShortPoll(5_000)
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nEdited while the watcher slept\n`, 8888)

    // The default 30 s window would still be asleep at 5 s plus the debounce.
    vi.advanceTimersByTime(5_000 + 1_500)
    await settle()

    expect(writer.calls.slice(baseline).map((call) => call.method)).toEqual(['delete', 'insert'])
    indexer.stop()
  })

  it('runs no sweep at all when pollIntervalMs is 0', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer } = makeFixtureShortPoll(0)
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nEdit nobody reports\n`, 9999)

    vi.advanceTimersByTime(120_000)
    await settle()

    expect(writer.calls.length).toBe(baseline)
    indexer.stop()
  })
})

describe('insert clamps to the schema column widths', () => {
  it('truncates stored scalars to the core MILVUS_SCALAR_MAX_LENGTHS', async () => {
    const longHeader = 'H'.repeat(MILVUS_SCALAR_MAX_LENGTHS.sectionHeader + 400)
    const fs = new MemFs()
    fs.add('/vault/long.md', `---\ntype: global\n---\n# ${longHeader}\n\nbody text\n`, 1)
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })

    await indexer.reindex()

    const rows = writer.calls
      .filter((call) => call.method === 'insert')
      .flatMap((call) => call.request.data!)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect((row[MILVUS_FIELDS.sectionHeader] as string).length)
        .toBeLessThanOrEqual(MILVUS_SCALAR_MAX_LENGTHS.sectionHeader)
      expect((row[MILVUS_FIELDS.chunkText] as string).length)
        .toBeLessThanOrEqual(MILVUS_SCALAR_MAX_LENGTHS.chunkText)
      expect((row[MILVUS_FIELDS.sourcePath] as string).length)
        .toBeLessThanOrEqual(MILVUS_SCALAR_MAX_LENGTHS.sourcePath)
      expect((row[MILVUS_FIELDS.vault] as string).length)
        .toBeLessThanOrEqual(MILVUS_SCALAR_MAX_LENGTHS.vault)
    }
    // The chunkId input and the vault column agree on the same stored path.
    expect(rows[0]![MILVUS_FIELDS.vault]).toBe('/vault')
  })
})

/**
 * TASK-060: the run-loop error accounting the "offline, retry on the next
 * run" contract leans on. Each failure mode must count errors, keep the
 * state dirty (so the next diff re-dirties the file), and never lose data
 * the Milvus write path refused.
 */
describe('run-loop failure accounting', () => {
  // MemFs whose state writes fail (EIO): the vault is on a dying disk.
  class FailOnWriteFs extends MemFs {
    override writeFile(): void {
      throw new Error('EIO: state write failed')
    }
  }

  function embedderWrapper(
    options: { throwOn?: string; shortBy?: boolean },
  ): Embedder {
    const inner = fakeEmbedder({ vectorDim: 8 })
    return {
      modelId: inner.modelId,
      dim: inner.dim,
      embedPassages: async (texts) => {
        if (options.throwOn !== undefined && texts.some((text) => text.includes(options.throwOn!))) {
          throw new Error('embedder: onnx session died')
        }
        const vectors = await inner.embedPassages(texts)
        return options.shortBy === true ? vectors.slice(1) : vectors
      },
      embedQuery: inner.embedQuery,
    }
  }

  it('counts a per-file embedder failure, retries it on the next run', async () => {
    const fs = new MemFs()
    seedVault(fs)
    const writer = stubWriter()
    let broken = true
    const flaky: Embedder = {
      modelId: 'fake-deterministic-embedder',
      dim: 8,
      embedPassages: async (texts) => {
        if (broken && texts.some((text) => text.includes('Beta flags'))) {
          throw new Error('embedder: onnx session died')
        }
        return await fakeEmbedder({ vectorDim: 8 }).embedPassages(texts)
      },
      embedQuery: (text) => fakeEmbedder({ vectorDim: 8 }).embedQuery(text),
    }
    const logs: string[] = []
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: flaky,
      writer: writer.writer,
      fs,
      log: (message) => logs.push(message),
    })

    const first = await indexer.reindex()

    expect(first.indexed).toBe(1)
    expect(first.errors).toBe(1)
    expect(filesOf(fs.state())['sub/b.md']).toBeUndefined()
    expect(logs.some((line) => line.includes('sub/b.md failed'))).toBe(true)

    broken = false
    const second = await indexer.reindex()

    expect(second.indexed).toBe(1)
    expect(filesOf(fs.state())['sub/b.md']).toBeDefined()
  })

  it('keeps a removed file dirty when its stale delete fails, purging next run', async () => {
    let deleteFailures = 1
    const memFs = new MemFs()
    seedVault(memFs)
    const calls: WriterCall[] = []
    const ok = { status: { error_code: 'Success', code: 0, reason: '' } }
    const writer: IndexWriter = {
      async insert(request) {
        calls.push({ method: 'insert', request })
        return ok
      },
      async delete(request) {
        calls.push({ method: 'delete', request })
        if (deleteFailures > 0) {
          deleteFailures -= 1
          throw new Error('milvus delete: 14 UNAVAILABLE')
        }
        return ok
      },
    }
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer,
      fs: memFs,
      log: () => undefined,
    })
    await indexer.reindex()
    const betaIds = filesOf(memFs.state())['sub/b.md']!.chunkIds
    memFs.remove('/vault/sub/b.md')

    const first = await indexer.reindex()

    expect(first.errors).toBe(1)
    expect(first.purged).toBe(0)
    expect(filesOf(memFs.state())['sub/b.md']).toBeDefined()

    const second = await indexer.reindex()

    expect(second.purged).toBe(1)
    expect(filesOf(memFs.state())['sub/b.md']).toBeUndefined()
    expect(calls.filter((call) => call.method === 'delete').at(-1)!.request.ids).toEqual(betaIds)
  })

  it('keeps the archived file dirty when its purge delete fails', async () => {
    const memFs = new MemFs()
    seedVault(memFs)
    let deleteFailures = 1
    const calls: WriterCall[] = []
    const ok = { status: { error_code: 'Success', code: 0, reason: '' } }
    const writer: IndexWriter = {
      async insert(request) {
        calls.push({ method: 'insert', request })
        return ok
      },
      async delete(request) {
        calls.push({ method: 'delete', request })
        if (deleteFailures > 0) {
          deleteFailures -= 1
          throw new Error('milvus delete: 14 UNAVAILABLE')
        }
        return ok
      },
    }
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer,
      fs: memFs,
      log: () => undefined,
    })
    await indexer.reindex()
    const alphaIds = filesOf(memFs.state())['a.md']!.chunkIds
    memFs.add('/vault/a.md', ALPHA_NOTE.replace('archive: false', 'archive: true'), 4444)

    const summary = await indexer.reindex()

    expect(summary.errors).toBe(1)
    expect(summary.purged).toBe(0)
    // State kept the old chunk ids: the next run retries the purge.
    expect(filesOf(memFs.state())['a.md']!.chunkIds).toEqual(alphaIds)

    const retry = await indexer.reindex()

    expect(retry.purged).toBe(1)
    expect(filesOf(memFs.state())['a.md']!.chunkIds).toEqual([])
  })

  it('fails a file when the embedder returns the wrong vector count', async () => {
    const memFs = new MemFs()
    seedVault(memFs)
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: embedderWrapper({ shortBy: true }),
      writer: writer.writer,
      fs: memFs,
      log: () => undefined,
    })

    const summary = await indexer.reindex()

    expect(summary.indexed).toBe(0)
    expect(summary.errors).toBe(2)
    expect(writer.calls.filter((call) => call.method === 'insert')).toHaveLength(0)
    expect(filesOf(memFs.state())).toEqual({})
  })

  it('surfaces a background reindex failure from start() as a counted error, not a crash', async () => {
    const logs: string[] = []
    const fs = new FailOnWriteFs()
    fs.add('/vault/a.md', ALPHA_NOTE, 1)
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      watchFactory: () => null,
      log: (message) => logs.push(message),
    })

    indexer.start()
    await settle()
    indexer.stop()

    // The per-file saveState throws first: the file is counted failed and
    // the run itself never stamps. Either way start() swallowed the throw.
    expect(indexer.progress.errors).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes('file a.md failed'))).toBe(true)
  })

  it('catches and logs a reindex rejection raised after the file loop', async () => {
    const logs: string[] = []
    const fs = new FailOnWriteFs()
    // No markdown files at all: the loop never errors, so the only
    // saveState left is the run-end stamp, and its throw rejects the
    // whole reindex — the exact shape start()'s background catch exists
    // for.
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      watchFactory: () => null,
      log: (message) => logs.push(message),
    })

    indexer.start()
    await settle()
    indexer.stop()

    expect(indexer.progress.errors).toBe(1)
    expect(logs.some((line) => line.includes('background reindex failed'))).toBe(true)
  })

  it('logs and counts a rejected watcher indexFile without throwing', async () => {
    vi.useFakeTimers()
    const { fs, indexer, listeners } = makeFixture({ embedder: embedderWrapper({ throwOn: 'Watcher edit' }) })
    indexer.start()
    await settle()

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nWatcher edit\n`, 6666)
    listeners[0]!('a.md')
    vi.advanceTimersByTime(1_500)
    await settle()

    expect(indexer.progress.errors).toBe(1)
    indexer.stop()
  })

  it('treats a null (unattributable) watch event as a whole-vault rescan', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer, listeners } = makeFixture()
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/a.md', `${ALPHA_NOTE}\nUnattributed change\n`, 7777)
    listeners[0]!(null)
    vi.advanceTimersByTime(1_500)
    await settle()

    expect(writer.calls.slice(baseline).map((call) => call.method)).toEqual(['delete', 'insert'])
    indexer.stop()
  })
})

describe('state file and path guards', () => {
  it('starts fresh when the state file is unreadable', async () => {
    const { fs, indexer } = makeFixture()
    fs.add(`/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`, '{not json', 5)

    const summary = await indexer.reindex()

    expect(summary.indexed).toBe(2)
    expect(summary.errors).toBe(0)
    expect(Object.keys(filesOf(fs.state())).sort()).toEqual(['a.md', 'sub/b.md'])
  })

  it('forces a full re-embed when the state file predates the schema version', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    // Downgrade the stamp on disk: same hashes, old schema version. A
    // freshly built indexer (the service restart shape) must treat every
    // file as unproven, not content-diff its way to a no-op.
    const state = fs.files.get(`/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`)!
    const parsed = JSON.parse(state.content) as { version: number }
    state.content = JSON.stringify({ ...parsed, version: 0 })
    const before = writer.calls.length
    const restarted = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })

    const summary = await restarted.reindex()

    expect(summary.indexed).toBe(2)
    expect(writer.calls.length).toBeGreaterThan(before)
    expect((JSON.parse(fs.files.get(`/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`)!.content) as { version: number }).version)
      .toBe(INDEX_STATE_VERSION)
  })

  // The 1 → 2 bump is the layout migration lever: a vault whose state keys
  // still carry the `markdown/` prefix must purge those stale keys (and
  // their chunk rows) through the ordinary stale-delete path, then
  // re-embed the same notes under root-relative keys.
  it('version 1 state purges stale markdown-prefixed keys and re-embeds root-relative', async () => {
    const fs = new MemFs()
    fs.add('/vault/x.md', ALPHA_NOTE, 1111)
    fs.add(`/vault/.obsidian-mem/metadata/${STATE_FILE_NAME}`, `${JSON.stringify({
      version: 1,
      modelId: 'fake-deterministic-embedder',
      vectorDim: 8,
      files: {
        'markdown/x.md': { contentHash: 'legacy-hash', mtimeMs: 1111, chunkIds: [111, 222] },
      },
    }, null, 2)}\n`, 5)
    const writer = stubWriter()
    const migrated = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared', globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
      embedder: fakeEmbedder({ vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })

    const summary = await migrated.reindex()

    // The stale key's stored chunk ids are deleted from Milvus verbatim.
    const deletes = writer.calls.filter((call) => call.method === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.request.ids).toEqual([111, 222])
    expect(summary.purged).toBe(1)
    expect(summary.indexed).toBe(1)
    const state = filesOf(fs.state())
    expect(state['markdown/x.md']).toBeUndefined()
    expect(Object.keys(state)).toEqual(['x.md'])
    expect(state['x.md']!.chunkIds).not.toEqual([111, 222])
    const rows = writer.calls.filter((call) => call.method === 'insert').flatMap((call) => call.request.data!)
    expect(rows[0]).toMatchObject({ [MILVUS_FIELDS.sourcePath]: 'x.md' })
    expect((fs.state() as { version: number }).version).toBe(2)
  })

  it('normalizes away dotfile and reserved names on the write-through hook', async () => {
    const { fs, indexer } = makeFixture()
    await indexer.reindex()
    const stateBefore = JSON.stringify(fs.state())

    await indexer.indexFile('/vault/.INTENTS.md')
    await indexer.indexFile('DREAMS.md')
    await indexer.indexFile('topic_history.md')

    expect(JSON.stringify(fs.state())).toBe(stateBefore)
  })
})

describe('nodeIndexerFs over real disk', () => {
  it('lists, reads, writes, renames, stats, and mkdirps through node:fs', () => {
    const base = mkdtempSync(join(tmpdir(), 'mem-indexerfs-'))
    try {
      const nested = join(base, 'deep', 'er')
      nodeIndexerFs.mkdirp(nested)
      expect(nodeIndexerFs.listDirectory(nested)).toEqual([])
      expect(nodeIndexerFs.listDirectory(join(base, 'missing'))).toBeNull()

      const file = join(nested, 'note.md')
      nodeIndexerFs.writeFile(file, '# hi\n')
      expect(nodeIndexerFs.readFile(file)).toBe('# hi\n')
      expect(nodeIndexerFs.readFile(join(nested, 'gone.md'))).toBeNull()
      expect(nodeIndexerFs.stat(file)!.mtimeMs).toBeGreaterThan(0)
      expect(nodeIndexerFs.stat(join(nested, 'gone.md'))).toBeNull()

      const moved = join(nested, 'moved.md')
      nodeIndexerFs.rename(file, moved)
      expect(readFileSync(moved, 'utf8')).toBe('# hi\n')
      writeFileSync(file, 'again\n')
      expect(nodeIndexerFs.readFile(file)).toBe('again\n')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
