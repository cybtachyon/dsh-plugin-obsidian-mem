import { afterEach, describe, expect, it, vi } from 'vitest'

import { MILVUS_FIELDS, MILVUS_SCALAR_MAX_LENGTHS } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import type { Embedder } from '../src/embedder.ts'
import {
  IndexerManager,
  MAX_CHUNKS_PER_FILE,
  STATE_FILE_NAME,
  VaultIndexer,
} from '../src/indexer.ts'
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
    const raw = this.files.get(`${vaultPath}/metadata/${STATE_FILE_NAME}`)?.content
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
  memFs.add('/vault/markdown/a.md', ALPHA_NOTE, 1111)
  memFs.add('/vault/markdown/sub/b.md', BETA_NOTE, 2222)
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
    vault: { path: '/vault', mode: 'shared' },
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
    vault: { path: '/vault', mode: 'shared' },
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
    fs.add('/vault/markdown/.hidden.md', '# hidden\n', 1)
    fs.add('/vault/markdown/DREAMS.md', '# dreams\n', 1)
    fs.add('/vault/markdown/old_history.md', '# history\n', 1)
    fs.add('/vault/markdown/notes.txt', 'not markdown\n', 1)
    fs.add('/vault/markdown/arch.md', [
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
      [MILVUS_FIELDS.sourcePath]: 'markdown/a.md',
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
    expect(Object.keys(state).sort()).toEqual(['markdown/a.md', 'markdown/arch.md', 'markdown/sub/b.md'])
    expect(state['markdown/arch.md']!.chunkIds).toEqual([])
    expect(fs.renames).toContainEqual({
      from: `/vault/metadata/${STATE_FILE_NAME}.tmp`,
      to: `/vault/metadata/${STATE_FILE_NAME}`,
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
    const oldIds = filesOf(fs.state())['markdown/a.md']!.chunkIds
    const before = writer.calls.length
    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nNew insight about **billing**.\n`, 3333)

    await indexer.reindex()

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
    expect(newCalls[0]!.request.ids).toEqual(oldIds)
    const rows = newCalls[1]!.request.data!
    expect(rows.some((row) => (row[MILVUS_FIELDS.wakeKeywords] as string[]).includes('billing'))).toBe(true)
    expect(filesOf(fs.state())['markdown/a.md']!.mtimeMs).toBe(3333)
  })

  it('deletes chunks of a removed file and drops its state entry', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const betaIds = filesOf(fs.state())['markdown/sub/b.md']!.chunkIds
    fs.remove('/vault/markdown/sub/b.md')
    const before = writer.calls.length

    await indexer.reindex()

    const deletes = writer.calls.slice(before).filter((call) => call.method === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.request.ids).toEqual(betaIds)
    expect(filesOf(fs.state())['markdown/sub/b.md']).toBeUndefined()
  })

  it('purges chunks of a note archived after it was indexed', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const alphaIds = filesOf(fs.state())['markdown/a.md']!.chunkIds
    fs.add('/vault/markdown/a.md', ALPHA_NOTE.replace('archive: false', 'archive: true'), 4444)
    const before = writer.calls.length

    await indexer.reindex()

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete'])
    expect(newCalls[0]!.request.ids).toEqual(alphaIds)
    expect(filesOf(fs.state())['markdown/a.md']!.chunkIds).toEqual([])
  })
})

describe('offline and migration', () => {
  it('keeps the failed file dirty when Milvus is offline and retries next run', async () => {
    const { fs, writer, indexer } = makeFixture({ writerOptions: { failInsertTimes: 1 } })

    await indexer.reindex()

    expect(indexer.progress.errors).toBe(1)
    // a.md (first alphabetically) failed; its state entry was not written.
    expect(filesOf(fs.state())['markdown/a.md']).toBeUndefined()
    const failedCalls = writer.calls.length

    await indexer.reindex()

    expect(filesOf(fs.state())['markdown/a.md']).toBeDefined()
    expect(writer.calls.length).toBeGreaterThan(failedCalls)
  })

  it('model swap: deletes every old-model chunk id and re-inserts fresh ids', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    const oldAlphaIds = filesOf(fs.state())['markdown/a.md']!.chunkIds
    const before = writer.calls.length

    const swapped = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared' },
      embedder: fakeEmbedder({ modelId: 'other-model', vectorDim: 8 }),
      writer: writer.writer,
      fs,
      log: () => undefined,
    })
    await swapped.reindex()

    const newCalls = writer.calls.slice(before)
    const deletes = newCalls.filter((call) => call.method === 'delete')
    expect(deletes[0]!.request.ids).toEqual(oldAlphaIds)
    const newAlphaIds = filesOf(fs.state())['markdown/a.md']!.chunkIds
    expect(newAlphaIds).not.toEqual(oldAlphaIds)
    expect((fs.state() as { modelId: string }).modelId).toBe('other-model')
  })
})

describe('write-through hook', () => {
  it('indexFile re-indexes one changed file by relative or absolute path', async () => {
    const { fs, writer, indexer } = makeFixture()
    await indexer.reindex()
    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nUpdated\n`, 5555)
    const before = writer.calls.length

    await indexer.indexFile('/vault/markdown/a.md')

    const newCalls = writer.calls.slice(before)
    expect(newCalls.map((call) => call.method)).toEqual(['delete', 'insert'])
  })

  it('indexFile on an unknown or removed path is safe', async () => {
    const { fs, indexer } = makeFixture()
    await indexer.reindex()
    const stateBefore = JSON.stringify(fs.state())

    await indexer.indexFile('markdown/never-indexed.md')
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

    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nWatcher edit\n`, 6666)
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

  it('falls back to stat polling when the watch factory is unsupported', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer } = makeFixture({ watchFactory: () => null })
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nMissed by the watcher\n`, 7777)

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
    const alphaRow = rows.find((row) => row[MILVUS_FIELDS.sourcePath] === 'markdown/a.md')!
    expect(alphaRow[MILVUS_FIELDS.wakeKeywords]).toContain('quantum')
    expect(alphaRow[MILVUS_FIELDS.wakeKeywords]).toContain('rate limiter')
    expect(alphaRow[MILVUS_FIELDS.triggerFrameworks]).toContain('solidjs')
  })

  it('caps the chunk text pasted into the prompt at 6000 chars', async () => {
    const prompts: string[] = []
    const fetchImpl: LlmFetch = async (_url, init) => {
      prompts.push((JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages[0]!.content)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }
    }
    const big = `# Big\n\n${'word '.repeat(3000)}\n`
    const { fs, indexer } = makeFixture({ llm: llmConfig, fetch: fetchImpl, env: { MEM_LLM_KEY: 'k' } })
    fs.add('/vault/markdown/big.md', big, 1)

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
      llm: { ...llmConfig, apiKeyEnv: undefined },
      fetch: fetchImpl,
    })

    await indexer.reindex()

    const rows = writer.calls.filter((call) => call.method === 'insert').flatMap((call) => call.request.data!)
    const alphaRow = rows.find((row) => row[MILVUS_FIELDS.sourcePath] === 'markdown/a.md')!
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
      llm: { ...llmConfig, apiKeyEnv: undefined },
      fetch: fetchImpl,
    })
    fs.add('/vault/markdown/c.md', '# Gamma\n\n**gamma** signal.\n', 3)
    fs.add('/vault/markdown/d.md', '# Delta\n\n**delta** signal.\n', 4)

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
    fs.add('/vault/markdown/many.md', manySections, 9)

    await indexer.reindex()

    const rows = writer.calls
      .filter((call) => call.method === 'insert')
      .map((call) => call.request.data!)
      .find((data) => data[0]![MILVUS_FIELDS.sourcePath] === 'markdown/many.md')
    expect(rows).toHaveLength(MAX_CHUNKS_PER_FILE)
  })

  it('IndexerManager reindexes every vault and aggregates progress', async () => {
    const fs = new MemFs()
    fs.add('/vaults/one/markdown/a.md', ALPHA_NOTE, 1)
    fs.add('/vaults/two/markdown/b.md', BETA_NOTE, 2)
    const writer = stubWriter()
    const manager = new IndexerManager({
      vaults: [
        { path: '/vaults/one', mode: 'shared' },
        { path: '/vaults/two', mode: 'read-only' },
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
    expect(sources).toContain('/vaults/one#markdown/a.md')
    expect(sources).toContain('/vaults/two#markdown/b.md')
    expect(manager.progress().indexed).toBe(2)
    expect(manager.vaultProgress('/vaults/two')).not.toBeNull()

    fs.add('/vaults/one/markdown/a.md', `${ALPHA_NOTE}\nWrite-through\n`, 5)
    expect(await manager.indexFile('/vaults/one', 'markdown/a.md')).toBe(true)
    expect(await manager.indexFile('/vaults/none', 'markdown/a.md')).toBe(false)
  })
})

describe('stat sweep configuration', () => {
  it('runs the sweep on pollIntervalMs when the caller overrides the default', async () => {
    vi.useFakeTimers()
    const { fs, writer, indexer } = makeFixtureShortPoll(5_000)
    indexer.start()
    await settle()
    const baseline = writer.calls.length

    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nEdited while the watcher slept\n`, 8888)

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

    fs.add('/vault/markdown/a.md', `${ALPHA_NOTE}\nEdit nobody reports\n`, 9999)

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
    fs.add('/vault/markdown/long.md', `---\ntype: global\n---\n# ${longHeader}\n\nbody text\n`, 1)
    const writer = stubWriter()
    const indexer = new VaultIndexer({
      vault: { path: '/vault', mode: 'shared' },
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
