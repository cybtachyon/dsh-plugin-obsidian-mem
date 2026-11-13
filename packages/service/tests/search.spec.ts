import { describe, expect, it } from 'vitest'

import { MILVUS_FIELDS } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import {
  IndexOfflineError,
  SEARCH_OUTPUT_FIELDS,
  buildFilterExpr,
  hybridSearch,
  searchExactSections,
} from '../src/search.ts'
import type { HybridSearchDispatch, SearchMilvus } from '../src/search.ts'
import type { SearchDependencies } from '../src/search.ts'

/**
 * Hybrid-search spec for TASK-024 with fakes only: golden filter
 * expressions (the shared builder), the hybridSearch dispatch shape
 * (data[] sub-requests, per-item metric_type and expr, RRFRanker(60),
 * G10 output_fields), the count(*) empty guard, dedupe/token budgets/
 * mode resolution, the exact-section fallback, and the typed
 * offline degradation.
 */

interface Recorded {
  method: string
  request: Record<string, unknown>
}

interface StubOptions {
  countValue?: number
  results?: Array<Record<string, unknown>>
  errorStatusOn?: string
  throwOn?: string
}

function stubMilvus(options: StubOptions = {}) {
  const calls: Recorded[] = []
  const ok = { error_code: 'Success', code: 0, reason: '' }
  const client = {
    async count(request: Record<string, unknown>) {
      calls.push({ method: 'count', request })
      if (options.throwOn === 'count') {
        throw new Error('14 UNAVAILABLE: connect ECONNREFUSED')
      }
      if (options.errorStatusOn === 'count') {
        return { status: { error_code: 'ServerError', reason: 'gone' }, data: 0 }
      }
      return { status: ok, data: options.countValue ?? 12 }
    },
    async hybridSearch(request: Record<string, unknown>) {
      calls.push({ method: 'hybridSearch', request })
      if (options.throwOn === 'hybridSearch') {
        throw new Error('2 UNKNOWN: channel shutdown')
      }
      if (options.errorStatusOn === 'hybridSearch') {
        return { status: { error_code: 'ServerError', reason: 'released' } }
      }
      return { status: ok, results: options.results ?? [] }
    },
  }
  return { client: client as unknown as SearchMilvus, calls }
}

function deps(client: SearchMilvus, overrides: Partial<SearchDependencies> = {}): SearchDependencies {
  return {
    client,
    embedder: fakeEmbedder({ vectorDim: 8 }),
    vaultModeFor: (vault: string) => (vault === '/vaults/shared' ? 'shared' : 'read-only'),
    ...overrides,
  }
}

function hybridCalls(calls: readonly Recorded[]): HybridSearchDispatch[] {
  return calls.filter((call) => call.method === 'hybridSearch')
    .map((call) => call.request as unknown as HybridSearchDispatch)
}

/** Stub whose hybridSearch returns one scripted page per call. */
function stubSequenced(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Recorded[] = []
  const ok = { error_code: 'Success', code: 0, reason: '' }
  let page = 0
  const client = {
    async count(request: Record<string, unknown>) {
      calls.push({ method: 'count', request })
      return { status: ok, data: 5 }
    },
    async hybridSearch(request: Record<string, unknown>) {
      calls.push({ method: 'hybridSearch', request })
      const results = pages[page] ?? []
      page += 1
      return { status: ok, results }
    },
  }
  return { client: client as unknown as SearchMilvus, calls }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [MILVUS_FIELDS.chunkId]: 1000,
    [MILVUS_FIELDS.sourcePath]: 'notes/a.md',
    [MILVUS_FIELDS.sectionHeader]: 'Setup',
    [MILVUS_FIELDS.scope]: 'domain',
    [MILVUS_FIELDS.vault]: '/vaults/shared',
    [MILVUS_FIELDS.updatedAt]: 1700000000000,
    [MILVUS_FIELDS.chunkText]: 'chunk body text',
    score: 0.03,
    ...overrides,
  }
}

describe('buildFilterExpr golden expressions', () => {
  it('renders every clause in fixed order joined by and', () => {
    const expr = buildFilterExpr({
      scopes: ['global', 'proj-x'],
      ext: '.ts',
      frameworks: ['react', 'vue'],
      wakeKeywords: ['debug'],
      vaults: ['/vaults/shared'],
      sourcePath: 'notes/a.md',
    })

    expect(expr).toBe('scope IN ["global", "proj-x"]'
      + ' and ARRAY_CONTAINS(trigger_extensions, ".ts")'
      + ' and ARRAY_CONTAINSAny(trigger_frameworks, ["react", "vue"])'
      + ' and ARRAY_CONTAINSAny(wake_keywords, ["debug"])'
      + ' and vault IN ["/vaults/shared"]'
      + ' and source_path == "notes/a.md"')
  })

  it('normalizes the ext clause to one dotted lowercase form', () => {
    expect(buildFilterExpr({ ext: ' TS ' })).toBe('ARRAY_CONTAINS(trigger_extensions, ".ts")')
  })

  it('escapes quotes and backslashes inside quoted values', () => {
    const expr = buildFilterExpr({ sourcePath: 'notes/we"ird\\path.md' })

    expect(expr).toBe('source_path == "notes/we\\"ird\\\\path.md"')
  })

  it('skips empty lists and returns undefined when nothing applies', () => {
    expect(buildFilterExpr({ scopes: [], frameworks: [], wakeKeywords: [], vaults: [] })).toBeUndefined()
    expect(buildFilterExpr({})).toBeUndefined()
  })
})

describe('hybridSearch dispatch', () => {
  it('sends dense + BM25 sub-requests with per-item metric_type, expr, and RRF fusion', async () => {
    const { client, calls } = stubMilvus({ results: [row()] })

    await hybridSearch(deps(client), {
      query: 'how do i rate limit',
      ext: '.ts',
      topK: 4,
    })

    const [hybrid] = hybridCalls(calls)
    expect(hybrid).toBeDefined()
    expect(hybrid!.collection_name).toBe('obsidian_mem')
    expect(hybrid!.data).toHaveLength(2)
    expect(hybrid!.data[0]).toMatchObject({
      anns_field: MILVUS_FIELDS.denseVector,
      limit: 8,
      metric_type: 'COSINE',
      expr: 'ARRAY_CONTAINS(trigger_extensions, ".ts")',
    })
    expect(Array.isArray(hybrid!.data[0]!.data[0])).toBe(true)
    expect(hybrid!.data[1]).toMatchObject({
      anns_field: MILVUS_FIELDS.sparseVector,
      limit: 8,
      metric_type: 'BM25',
      expr: 'ARRAY_CONTAINS(trigger_extensions, ".ts")',
    })
    // The BM25 route carries the raw query text, not a vector.
    expect(hybrid!.data[1]!.data).toEqual(['how do i rate limit'])
    expect(hybrid!.rerank).toEqual({ strategy: 'rrf', params: { k: 60 } })
    expect(hybrid!.limit).toBe(8)
    expect(hybrid!.consistency_level).toBe('Strong')
  })

  it('always projects the primary key and result columns (G10)', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x' })

    const [hybrid] = hybridCalls(calls)
    expect(hybrid!.output_fields).toContain(MILVUS_FIELDS.chunkId)
    expect(hybrid!.output_fields).toEqual([...SEARCH_OUTPUT_FIELDS])
    for (const field of ['source_path', 'section_header', 'scope', 'vault', 'updated_at', 'chunk_text']) {
      expect(hybrid!.output_fields).toContain(field)
    }
  })

  it('omits expr on both routes when no filters are given', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x' })

    const [hybrid] = hybridCalls(calls)
    for (const route of hybrid!.data) {
      expect(route.expr).toBeUndefined()
    }
  })

  it('clamps topK to the search maximum and defaults the candidate limit', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x', topK: 100 })
    await hybridSearch(deps(client), { query: 'x' })

    const [capped, defaulted] = hybridCalls(calls)
    expect(capped!.limit).toBe(40)
    expect(defaulted!.limit).toBe(12)
  })

  it('skips the hybrid dispatch entirely when count says the collection is empty', async () => {
    const { client, calls } = stubMilvus({ countValue: 0 })

    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results).toEqual([])
    expect(calls.map((call) => call.method)).toEqual(['count'])
  })
})

describe('hybridSearch results', () => {
  it('dedupes source_path + section_header keeping the best score and truncates text', async () => {
    const long = 'x'.repeat(1000)
    const { client } = stubMilvus({
      results: [
        row({ [MILVUS_FIELDS.chunkId]: 1, score: 0.016 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, score: 0.032 }),
        row({
          [MILVUS_FIELDS.chunkId]: 3,
          [MILVUS_FIELDS.sourcePath]: 'notes/b.md',
          [MILVUS_FIELDS.sectionHeader]: 'Other',
          [MILVUS_FIELDS.chunkText]: long,
          score: 0.02,
        }),
      ],
    })

    const results = await hybridSearch(deps(client), { query: 'x', topK: 5, tokenCap: 50 })

    expect(results.map((result) => result.chunk_id)).toEqual([2, 3])
    expect(results[1]!.chunk_text).toHaveLength(200)
    expect(results[0]!.mode).toBe('shared')
    expect(results[0]!.scope).toBe('domain')
    expect(results[0]!.updated_at).toBe(1700000000000)
  })

  it('applies minScore to fused scores only', async () => {
    const { client } = stubMilvus({
      results: [
        row({ [MILVUS_FIELDS.chunkId]: 1, score: 0.03 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B', score: 0.005 }),
      ],
    })

    const results = await hybridSearch(deps(client), { query: 'x', minScore: 0.01 })

    expect(results.map((result) => result.chunk_id)).toEqual([1])
  })
})

describe('offline degradation', () => {
  it('wraps transport failures into the typed IndexOfflineError', async () => {
    const { client } = stubMilvus({ throwOn: 'count' })

    await expect(hybridSearch(deps(client), { query: 'x' }))
      .rejects.toThrowError(IndexOfflineError)
  })

  it('wraps resolved-but-failed statuses too (the SDK does not throw)', async () => {
    const { client } = stubMilvus({ errorStatusOn: 'hybridSearch' })

    await expect(hybridSearch(deps(client), { query: 'x' }))
      .rejects.toThrow(/hybridSearch: ServerError/)
  })
})

describe('searchExactSections', () => {
  it('filters on the exact source_path first', async () => {
    const { client, calls } = stubMilvus({ results: [row({ [MILVUS_FIELDS.sourcePath]: 'src/app.tsx' })] })

    const results = await searchExactSections(deps(client), {
      filePath: 'src/app.tsx',
      ext: '.tsx',
      snippet: 'export function App',
    })

    const hybrids = hybridCalls(calls)
    expect(hybrids).toHaveLength(1)
    expect(results).toHaveLength(1)
    for (const route of hybrids[0]!.data) {
      expect(route.expr).toBe('source_path == "src/app.tsx"')
    }
    // k defaults to RECALL_READ_MAX_SECTIONS (2), candidates are k*2.
    expect(hybrids[0]!.limit).toBe(4)
  })

  it('falls back to ext + framework filters when the exact file has no chunks', async () => {
    const { client, calls } = stubSequenced([[], [row({ [MILVUS_FIELDS.sourcePath]: 'notes/other.md' })]])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
    })

    expect(results).toHaveLength(1)
    const hybrids = hybridCalls(calls)
    expect(hybrids).toHaveLength(2)
    expect(hybrids[0]!.data[0]!.expr).toBe('source_path == "src/widget.tsx"')
    expect(hybrids[1]!.data[0]!.expr)
      .toBe('ARRAY_CONTAINS(trigger_extensions, ".tsx") and ARRAY_CONTAINSAny(trigger_frameworks, ["react"])')
  })

  it('uses directory signals as wake keywords only when nothing else narrows', async () => {
    const { client, calls } = stubSequenced([[], [row()]])

    await searchExactSections(deps(client), {
      filePath: 'notes/plain.md',
      dirSignals: ['src/', 'app/'],
      snippet: 'deployment notes',
    })

    const hybrids = hybridCalls(calls)
    expect(hybrids[1]!.data[0]!.expr).toBe('ARRAY_CONTAINSAny(wake_keywords, ["src", "app"])')
  })

  it('returns empty when both exact and fallback dispatches find nothing', async () => {
    const { client } = stubMilvus({ results: [] })

    const results = await searchExactSections(deps(client), { filePath: 'notes/missing.md' })

    expect(results).toEqual([])
  })

  it('budgets each section at sectionTokens', async () => {
    const long = 'y'.repeat(2000)
    const { client } = stubMilvus({ results: [row({ [MILVUS_FIELDS.chunkText]: long })] })

    const results = await searchExactSections(deps(client), {
      filePath: 'notes/a.md',
      sectionTokens: 100,
    })

    expect(results[0]!.chunk_text).toHaveLength(400)
  })
})
