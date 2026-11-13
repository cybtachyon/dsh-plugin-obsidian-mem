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
import type { SearchMilvus, SearchRouteDispatch } from '../src/search.ts'
import type { SearchDependencies } from '../src/search.ts'

/**
 * Hybrid-search spec for TASK-024 with the TASK-004 two-route split,
 * fakes only: golden filter expressions (the shared builder), the two
 * standalone search dispatches (per-route params goldens: dense ef +
 * radius + range_filter, sparse empty; expr, candidate limit, Strong
 * consistency, G10 output_fields), the count(*) empty guard, the
 * client-side RRF fusion math, the sparse -score cutoff, the TASK-009
 * default fused floor (default filtering, explicit 0 disables, explicit
 * override), dedupe/token budgets/mode resolution, the exact-section
 * fallback with its TASK-014 fused floor (exact-file leg unfloored), and
 * the typed offline degradation.
 */

interface Recorded {
  method: string
  request: Record<string, unknown>
}

interface StubOptions {
  countValue?: number
  /** Page for both routes; the per-route options win when present. */
  results?: Array<Record<string, unknown>>
  denseResults?: Array<Record<string, unknown>>
  sparseResults?: Array<Record<string, unknown>>
  errorStatusOn?: 'count' | 'search'
  throwOn?: 'count' | 'search'
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
    async search(request: Record<string, unknown>) {
      calls.push({ method: 'search', request })
      if (options.throwOn === 'search') {
        throw new Error('2 UNKNOWN: channel shutdown')
      }
      if (options.errorStatusOn === 'search') {
        return { status: { error_code: 'ServerError', reason: 'released' } }
      }
      const scripted = request.anns_field === MILVUS_FIELDS.denseVector
        ? options.denseResults ?? options.results
        : options.sparseResults ?? options.results
      return { status: ok, results: scripted ?? [] }
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

function searchDispatches(calls: readonly Recorded[]): SearchRouteDispatch[] {
  return calls.filter((call) => call.method === 'search')
    .map((call) => call.request as unknown as SearchRouteDispatch)
}

/** Stub whose search consumes one scripted page per dispatch (both routes). */
function stubSequenced(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Recorded[] = []
  const ok = { error_code: 'Success', code: 0, reason: '' }
  let page = 0
  let secondRoute = false
  const client = {
    async count(request: Record<string, unknown>) {
      calls.push({ method: 'count', request })
      return { status: ok, data: 5 }
    },
    async search(request: Record<string, unknown>) {
      calls.push({ method: 'search', request })
      const results = pages[page] ?? []
      if (secondRoute) {
        page += 1
      }
      secondRoute = !secondRoute
      return { status: ok, results }
    },
  }
  return { client: client as unknown as SearchMilvus, calls }
}

// Default score -9 reads as BM25 relevancy 9 against the negated-score
// shape (radius-tuning-findings §3), so a default row survives both the
// sparse client cutoff and the dense route (whose score fusion ignores).
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [MILVUS_FIELDS.chunkId]: 1000,
    [MILVUS_FIELDS.sourcePath]: 'notes/a.md',
    [MILVUS_FIELDS.sectionHeader]: 'Setup',
    [MILVUS_FIELDS.scope]: 'domain',
    [MILVUS_FIELDS.vault]: '/vaults/shared',
    [MILVUS_FIELDS.updatedAt]: 1700000000000,
    [MILVUS_FIELDS.chunkText]: 'chunk body text',
    score: -9,
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
      + ' and ARRAY_CONTAINS_ANY(trigger_frameworks, ["react", "vue"])'
      + ' and ARRAY_CONTAINS_ANY(wake_keywords, ["debug"])'
      + ' and vault IN ["/vaults/shared"]'
      + ' and source_path == "notes/a.md"')
  })

  it('normalizes the ext clause to one dotted lowercase form', () => {
    expect(buildFilterExpr({ ext: ' TS ' })).toBe('ARRAY_CONTAINS(trigger_extensions, ".ts")')
  })

  it('normalizes the ext through the same canonical form the extractor stored', () => {
    // core's normalizeExtension defines the spelling; a filter that keeps
    // stray characters would silently match nothing.
    expect(buildFilterExpr({ ext: ' TS ' })).toBe('ARRAY_CONTAINS(trigger_extensions, ".ts")')
    expect(buildFilterExpr({ ext: 'ts,' })).toBe('ARRAY_CONTAINS(trigger_extensions, ".ts")')
    expect(buildFilterExpr({ ext: '.' })).toBeUndefined()
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

describe('two-route search dispatch', () => {
  it('dispatches standalone dense + BM25 searches with the verified shapes', async () => {
    const { client, calls } = stubMilvus({ results: [row()] })

    await hybridSearch(deps(client), {
      query: 'how do i rate limit',
      ext: '.ts',
      topK: 4,
    })

    const [dense, sparse] = searchDispatches(calls)
    expect(dense).toBeDefined()
    expect(sparse).toBeDefined()
    for (const dispatch of [dense!, sparse!]) {
      expect(dispatch.collection_name).toBe('obsidian_mem')
      expect(dispatch.limit).toBe(8)
      expect(dispatch.expr).toBe('ARRAY_CONTAINS(trigger_extensions, ".ts")')
      expect(dispatch.output_fields).toEqual([...SEARCH_OUTPUT_FIELDS])
      expect(dispatch.consistency_level).toBe('Strong')
    }
    expect(dense!.anns_field).toBe(MILVUS_FIELDS.denseVector)
    expect(dense!.metric_type).toBe('COSINE')
    expect(Array.isArray(dense!.data[0])).toBe(true)
    expect(dense!.params).toEqual({ ef: 64, radius: 0.78, range_filter: 1 })
    // Radius regression pin: lite also float-converts numeric STRINGS
    // (radius-tuning-findings §1), so only the emitted JSON type keeps
    // the pinned production value a number.
    expect(typeof dense!.params.radius).toBe('number')
    expect(typeof dense!.params.range_filter).toBe('number')
    expect(sparse!.anns_field).toBe(MILVUS_FIELDS.sparseVector)
    expect(sparse!.metric_type).toBe('BM25')
    // The BM25 route carries the raw query text, not a vector, and no
    // server params: its floor is the client-side -score cutoff.
    expect(sparse!.data).toEqual(['how do i rate limit'])
    expect(sparse!.params).toEqual({})
  })

  it('always projects the primary key and result columns on both routes (G10)', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x' })

    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(2)
    for (const dispatch of dispatches) {
      expect(dispatch.output_fields).toContain(MILVUS_FIELDS.chunkId)
      expect(dispatch.output_fields).toEqual([...SEARCH_OUTPUT_FIELDS])
      for (const field of ['source_path', 'section_header', 'scope', 'vault', 'updated_at', 'chunk_text']) {
        expect(dispatch.output_fields).toContain(field)
      }
    }
  })

  it('omits expr on both searches when no filters are given', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x' })

    for (const dispatch of searchDispatches(calls)) {
      expect(dispatch.expr).toBeUndefined()
    }
  })

  it('clamps topK to the search maximum and defaults the candidate limit on both routes', async () => {
    const { client, calls } = stubMilvus()

    await hybridSearch(deps(client), { query: 'x', topK: 100 })
    await hybridSearch(deps(client), { query: 'x' })

    const [cappedA, cappedB, defaultedA, defaultedB] = searchDispatches(calls)
    for (const dispatch of [cappedA!, cappedB!]) {
      expect(dispatch.limit).toBe(40)
    }
    for (const dispatch of [defaultedA!, defaultedB!]) {
      expect(dispatch.limit).toBe(12)
    }
  })

  it('skips both searches entirely when count says the collection is empty', async () => {
    const { client, calls } = stubMilvus({ countValue: 0 })

    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results).toEqual([])
    expect(calls.map((call) => call.method)).toEqual(['count'])
  })
})

describe('client RRF fusion', () => {
  it('fuses a chunk found by both routes at 1/(60+1) + 1/(60+1)', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B' }),
      ],
      sparseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
      ],
    })

    // minScore 0 disables the default fused floor: this pin is fusion
    // math, and the rank-2 single-route scores are exactly what the
    // default would drop.
    const results = await hybridSearch(deps(client), { query: 'x', minScore: 0 })

    // Chunks 2 and 3 fuse to the same 1/62 (each route's rank 2), so the
    // tie-break orders them by ascending chunk_id.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 2, 3])
    expect(results[0]!.score).toBe(1 / 61 + 1 / 61)
    expect(results[1]!.score).toBe(1 / 62)
    expect(results[2]!.score).toBe(1 / 62)
  })

  it('scores a single-route hit at rank r as 1/(60 + r)', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 10 }),
        row({ [MILVUS_FIELDS.chunkId]: 11, [MILVUS_FIELDS.sectionHeader]: 'B' }),
        row({ [MILVUS_FIELDS.chunkId]: 12, [MILVUS_FIELDS.sectionHeader]: 'C' }),
      ],
      sparseResults: [],
    })

    // minScore 0: the rank 2 and 3 single-route scores are exactly what
    // the TASK-009 default floor drops.
    const results = await hybridSearch(deps(client), { query: 'x', minScore: 0 })

    expect(results.map((result) => result.chunk_id)).toEqual([10, 11, 12])
    expect(results[0]!.score).toBe(1 / 61)
    expect(results[1]!.score).toBe(1 / 62)
    expect(results[2]!.score).toBe(1 / 63)
  })

  it('breaks fused-score ties by ascending chunk_id', async () => {
    const { client } = stubMilvus({
      // Chunk 7 takes dense rank 1, chunk 3 BM25 rank 1: identical fused
      // scores, and the later-first-seen chunk 3 must still come first.
      denseResults: [row({ [MILVUS_FIELDS.chunkId]: 7, [MILVUS_FIELDS.sectionHeader]: 'G' })],
      sparseResults: [row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' })],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results.map((result) => result.chunk_id)).toEqual([3, 7])
    expect(results[0]!.score).toBe(1 / 61)
    expect(results[1]!.score).toBe(1 / 61)
  })

  it('keeps the first-seen row fields when both routes hit the same chunk', async () => {
    const { client } = stubMilvus({
      denseResults: [row({ [MILVUS_FIELDS.chunkId]: 1, [MILVUS_FIELDS.chunkText]: 'from dense' })],
      sparseResults: [row({ [MILVUS_FIELDS.chunkId]: 1, [MILVUS_FIELDS.chunkText]: 'from sparse' })],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results).toHaveLength(1)
    expect(results[0]!.chunk_text).toBe('from dense')
    expect(results[0]!.score).toBe(1 / 61 + 1 / 61)
  })
})

describe('sparse BM25 client cutoff on -score', () => {
  it('keeps a hit whose -score equals the 2.5 floor and drops one below it', async () => {
    const { client } = stubMilvus({
      denseResults: [],
      sparseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1, score: -2.5 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B', score: -2.4999 }),
      ],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    // -(-2.5) == 2.5 survives; -(-2.4999) < 2.5 drops.
    expect(results.map((result) => result.chunk_id)).toEqual([1])
    expect(results[0]!.score).toBe(1 / 61)
  })

  it('leaves the dense route untouched: its cutoff is the server-side radius', async () => {
    const { client } = stubMilvus({
      // The server already cut the COSINE route by radius; a plain
      // COSINE-band score must not face the BM25 relevancy floor here.
      denseResults: [row({ [MILVUS_FIELDS.chunkId]: 1, score: 0.81 })],
      sparseResults: [],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results.map((result) => result.chunk_id)).toEqual([1])
  })
})

describe('default fused-score floor (TASK-009)', () => {
  // Fillers are single-route hits; ranks are positional, so a filler at
  // rank >= 2 fuses below the floor and is dropped. Unique section
  // headers keep them out of the source_path + section_header dedupe.
  function fillerRows(from: number, count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_unused, offset) => row({
      [MILVUS_FIELDS.chunkId]: from + offset,
      [MILVUS_FIELDS.sectionHeader]: `Filler ${from + offset}`,
    }))
  }

  it('drops single-route rank>=2-only hits, keeps rank-1 and both-route hits', async () => {
    // Fetched-window worst case: topK 20 with oversample 2 puts limit 40
    // on each route, so chunk 900 takes the window's last rank on BOTH
    // routes and still clears the floor at 2/(60+40) = 0.02 > 1/61.
    const deep = { [MILVUS_FIELDS.chunkId]: 900, [MILVUS_FIELDS.sectionHeader]: 'Deep' }
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 101, [MILVUS_FIELDS.sectionHeader]: 'A' }),
        ...fillerRows(102, 38),
        row(deep),
      ],
      sparseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 201, [MILVUS_FIELDS.sectionHeader]: 'B' }),
        ...fillerRows(202, 38),
        row(deep),
      ],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    // 101 and 201 are single-route rank-1 hits (score == floor, kept
    // inclusively); fillers 102..139 and 202..239 all sit under it.
    expect(results.map((result) => result.chunk_id)).toEqual([900, 101, 201])
    expect(results[0]!.score).toBe(1 / 100 + 1 / 100)
    expect(results[1]!.score).toBe(1 / 61)
  })

  it('lets an explicit minScore of 0 disable the default floor', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B' }),
        row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
      ],
      sparseResults: [],
    })

    // The same fixture without minScore returns only chunk 1: 1/62 and
    // 1/63 sit under the default floor.
    const results = await hybridSearch(deps(client), { query: 'x', minScore: 0 })

    expect(results.map((result) => result.chunk_id)).toEqual([1, 2, 3])
  })

  it('lets an explicit minScore override the default floor in both directions', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B' }),
        row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
      ],
      sparseResults: [],
    })

    // Below the floor (1/61 ~ 0.016393): 0.0161 keeps chunk 2's 1/62
    // (0.016129) that the default drops; 1/63 stays under both bounds.
    const relaxed = await hybridSearch(deps(client), { query: 'x', minScore: 0.0161 })
    expect(relaxed.map((result) => result.chunk_id)).toEqual([1, 2])

    // Above it: 0.0164 also cuts chunk 1's 1/61 (0.016393), which the
    // default keeps at equality, leaving nothing.
    const raised = await hybridSearch(deps(client), { query: 'x', minScore: 0.0164 })
    expect(raised.map((result) => result.chunk_id)).toEqual([])
  })
})

describe('result shaping', () => {
  it('dedupes source_path + section_header keeping the best fused score and truncates text', async () => {
    const long = 'x'.repeat(1000)
    const { client } = stubMilvus({
      // Chunks 2 and 1 share one section; chunk 2 holds dense rank 1, so
      // the section keeps chunk 2's higher fused score.
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 2 }),
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({
          [MILVUS_FIELDS.chunkId]: 3,
          [MILVUS_FIELDS.sourcePath]: 'notes/b.md',
          [MILVUS_FIELDS.sectionHeader]: 'Other',
          [MILVUS_FIELDS.chunkText]: long,
        }),
      ],
      sparseResults: [],
    })

    // minScore 0 keeps the sub-floor rank-3 chunk visible: this pin is
    // dedupe and the token budget, not the score floor.
    const results = await hybridSearch(deps(client), {
      query: 'x',
      topK: 5,
      tokenCap: 50,
      minScore: 0,
    })

    expect(results.map((result) => result.chunk_id)).toEqual([2, 3])
    expect(results[1]!.chunk_text).toHaveLength(200)
    expect(results[0]!.mode).toBe('shared')
    expect(results[0]!.scope).toBe('domain')
    expect(results[0]!.updated_at).toBe(1700000000000)
  })

  it('applies minScore to fused scores only', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B' }),
      ],
      sparseResults: [],
    })

    // Fused scores: chunk 1 = 1/61 (0.016393), chunk 2 = 1/62 (0.016129).
    // The floor cuts rank 2; raw route scores never reach the comparison.
    const results = await hybridSearch(deps(client), { query: 'x', minScore: 0.0162 })

    expect(results.map((result) => result.chunk_id)).toEqual([1])
  })
})

describe('offline degradation', () => {
  it('wraps transport failures into the typed IndexOfflineError', async () => {
    const { client } = stubMilvus({ throwOn: 'count' })

    await expect(hybridSearch(deps(client), { query: 'x' }))
      .rejects.toThrowError(IndexOfflineError)
  })

  it('wraps route search transport failures too', async () => {
    const { client } = stubMilvus({ throwOn: 'search' })

    await expect(hybridSearch(deps(client), { query: 'x' }))
      .rejects.toThrowError(IndexOfflineError)
  })

  it('wraps resolved-but-failed statuses (the SDK does not throw)', async () => {
    const { client } = stubMilvus({ errorStatusOn: 'search' })

    await expect(hybridSearch(deps(client), { query: 'x' }))
      .rejects.toThrow(/search: ServerError/)
  })
})

describe('searchExactSections', () => {
  it('filters on the exact source_path on both routes first', async () => {
    const { client, calls } = stubMilvus({ results: [row({ [MILVUS_FIELDS.sourcePath]: 'src/app.tsx' })] })

    const results = await searchExactSections(deps(client), {
      filePath: 'src/app.tsx',
      ext: '.tsx',
      snippet: 'export function App',
    })

    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(2)
    expect(results).toHaveLength(1)
    for (const dispatch of dispatches) {
      expect(dispatch.expr).toBe('source_path == "src/app.tsx"')
      // k defaults to RECALL_READ_MAX_SECTIONS (2), candidates are k*2.
      expect(dispatch.limit).toBe(4)
    }
  })

  it('falls back to ext + framework filters when the exact file has no chunks', async () => {
    const { client, calls } = stubSequenced([[], [row({ [MILVUS_FIELDS.sourcePath]: 'notes/other.md' })]])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
    })

    expect(results).toHaveLength(1)
    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(4)
    for (const dispatch of dispatches.slice(0, 2)) {
      expect(dispatch.expr).toBe('source_path == "src/widget.tsx"')
    }
    for (const dispatch of dispatches.slice(2)) {
      expect(dispatch.expr)
        .toBe('ARRAY_CONTAINS(trigger_extensions, ".tsx") and ARRAY_CONTAINS_ANY(trigger_frameworks, ["react"])')
    }
  })

  it('uses directory signals as wake keywords only when nothing else narrows', async () => {
    const { client, calls } = stubSequenced([[], [row()]])

    await searchExactSections(deps(client), {
      filePath: 'notes/plain.md',
      dirSignals: ['src/', 'app/'],
      snippet: 'deployment notes',
    })

    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(4)
    for (const dispatch of dispatches.slice(2)) {
      expect(dispatch.expr).toBe('ARRAY_CONTAINS_ANY(wake_keywords, ["src", "app"])')
    }
  })

  // One page feeds both routes of a dispatch pair (stubSequenced), so a
  // score-0.85 row dies on the sparse -score cutoff and fuses as a
  // single-route dense hit at its positional rank: the production shape
  // for sub-floor candidates.
  const floorPage = [
    row({ [MILVUS_FIELDS.chunkId]: 1, [MILVUS_FIELDS.sectionHeader]: 'A' }),
    row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B', score: 0.85 }),
    row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
  ]

  it('floors the fallback page: drops single-route rank-2-only rows, keeps the rest (TASK-014)', async () => {
    const { client } = stubSequenced([[], floorPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
      k: 3,
    })

    // chunk 2 sits at dense rank 2 alone (1/62 < the 1/61 default floor).
    // chunk 1 is both-route rank 1; chunk 3 is dense rank 3 + sparse
    // rank 2, and every both-route hit clears the floor.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 3])
    expect(results[0]!.score).toBe(1 / 61 + 1 / 61)
  })

  it('lets an explicit fallback minScore of 0 disable the floor (TASK-014)', async () => {
    const { client } = stubSequenced([[], floorPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
      k: 3,
      minScore: 0,
    })

    // The same page under the default floor returns only chunks 1 and 3.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 3, 2])
  })

  it('keeps the exact-file leg floor-free: a file being read is relevant by construction (TASK-014)', async () => {
    const exactPage = [
      row({ [MILVUS_FIELDS.chunkId]: 1, [MILVUS_FIELDS.sourcePath]: 'src/app.tsx' }),
      row({
        [MILVUS_FIELDS.chunkId]: 2,
        [MILVUS_FIELDS.sourcePath]: 'src/app.tsx',
        [MILVUS_FIELDS.sectionHeader]: 'B',
        score: 0.85,
      }),
    ]
    const { client, calls } = stubSequenced([exactPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/app.tsx',
      ext: '.tsx',
      k: 3,
    })

    // chunk 2's 1/62 would face the fallback floor; the exact page
    // returns it unfloored, and its non-empty answer skips the fallback.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 2])
    expect(searchDispatches(calls)).toHaveLength(2)
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
