import { describe, expect, it } from 'vitest'

import { MILVUS_FIELDS } from '../../core/lib/index.js'
import { fakeEmbedder } from '../src/embedder.ts'
import {
  IndexOfflineError,
  SEARCH_OUTPUT_FIELDS,
  buildFilterExpr,
  hybridSearch,
  searchExactSections,
  sparseQueryText,
} from '../src/search.ts'
import type { SearchMilvus, SearchRouteDispatch } from '../src/search.ts'
import type { SearchDependencies } from '../src/search.ts'

/**
 * Hybrid-search spec for TASK-024 with the TASK-004 two-route split,
 * fakes only: golden filter expressions (the shared builder), the two
 * standalone search dispatches (per-route params goldens: dense ef +
 * radius + range_filter, sparse empty; expr, candidate limit, Strong
 * consistency, G10 output_fields), the count(*) empty guard, the
 * client-side RRF fusion math, the sparse -score cutoff, the default
 * fused floor at 1/(k+2) (TASK-009 rule, TASK-007 value: default
 * filtering, explicit 0 disables, explicit override), dedupe/token
 * budgets/mode resolution, the exact-section fallback with its fused
 * floor (exact-file leg unfloored, TASK-014), the typed offline
 * degradation, and the stop-word strip: sparseQueryText tokenizer-table
 * goldens plus the stripped BM25 `data` on both dispatch seams with the
 * dense legs proven to carry the FULL query's vector (TASK-003).
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
    // The BM25 route carries the stop-word-stripped query text, not a
    // vector (sparseQueryText, TASK-002: 'how do i' stripped), and no
    // server params: its floor is the client-side -score cutoff. The
    // dense route above still embedded the FULL query.
    expect(sparse!.data).toEqual(['rate limit'])
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

describe('sparseQueryText tokenizer table (shipped behavior)', () => {
  // Goldens pinned against the SHIPPED lib (TASK-003 discipline: outputs
  // read off packages/service/lib/search.js after the build, not from
  // intent; re-run for this TASK-018 re-pin). Han forms maximal runs and
  // a run drops only when the WHOLE run is a list entry (the TASK-005
  // analyzer finding, rule home: the sparseQueryText docblock), kana and
  // Hangul are word characters and pass whole, hyphens and punctuation
  // are separators, '_' stays inside a word run, and casing survives
  // because removal matches on token.toLowerCase().
  it.each([
    ['collapses the spaces left by removed stopwords', 'the   rate   limit', 'rate limit'],
    ['splits hyphen and trailing-punctuation tokens', 'rate-limit!', 'rate limit'],
    ['keeps the hyphen halves that are not stop words', 'e-mail me', 'e mail'],
    ['treats underscore as part of the word run', 'rate_limit', 'rate_limit'],
    ['keeps digits inside word runs', 'top10 k8s', 'top10 k8s'],
    ['removes case-insensitively and keeps survivor casing', 'THE rate Limit', 'rate Limit'],
    ['leaves words the 108-entry eng list lacks', 'IPv6 address filtering', 'IPv6 address filtering'],
    ['passes a whole Han run untouched (TASK-018)', '我喜欢混合检索', '我喜欢混合检索'],
    ['keeps a Han run holding a function char whole', '智能体的共享记忆', '智能体的共享记忆'],
    ['drops a standalone single-char zho run', '智能体 的 共享记忆', '智能体 共享记忆'],
    ['drops standalone zho chars, keeps word runs', '我 喜欢 混合 检索', '喜欢 混合 检索'],
    ['keeps multi-char Han runs the zho list lacks', '时间 和 日期', '时间 日期'],
    ['keeps kana runs whole beside a Han run', 'テストの時間', 'テストの 時間'],
    ['passes Hangul through whole', '안녕하세요', '안녕하세요'],
    ['strips a zho single char between Latin words', 'upsert 和 delete', 'upsert delete'],
    ['fail-opens an all-stop-word query to the original', 'the a an of and is are', 'the a an of and is are'],
    ['fail-opens a lone zho char query to the original', '的', '的'],
    ['fail-opens a symbols-only query to the original', '?! ... @#', '?! ... @#'],
    ['returns empty input unchanged (identity via fail-open)', '', ''],
  ])('%s', (_label, query, expected) => {
    expect(sparseQueryText(query)).toBe(expected)
  })
})

describe('stop-word strip on the BM25 route (TASK-003 pins)', () => {
  it('sends the stripped text on BM25 while the dense route embeds the FULL query', async () => {
    const embedder = fakeEmbedder({ vectorDim: 8 })
    const { client, calls } = stubMilvus({ results: [row()] })
    const query = 'what does the Milvus indexer do?'

    await hybridSearch(deps(client, { embedder }), { query })

    const [dense, sparse] = searchDispatches(calls)
    // eng lists 'do' but not 'does', and no domain term drops: only the
    // true function words go.
    expect(sparse!.data).toEqual(['does Milvus indexer'])
    // The strip never reaches the embed the caller ran: the dense data is
    // the FULL query's vector, and the stripped text's vector is not it
    // (fakeEmbedder is a deterministic hash of the exact text).
    expect(dense!.data).toEqual([await embedder.embedQuery(query)])
    expect(dense!.data[0]).not.toEqual(await embedder.embedQuery('does Milvus indexer'))
  })

  it('fail-opens an all-stop-word query to the ORIGINAL text on BM25, never empty', async () => {
    const { client, calls } = stubMilvus({ results: [row()] })
    const query = 'the a of'

    await hybridSearch(deps(client), { query })

    const [, sparse] = searchDispatches(calls)
    expect(sparse!.data).toEqual([query])
  })

  it('strips the snippet on both searchExactSections pairs (shared dispatchRoutes)', async () => {
    const embedder = fakeEmbedder({ vectorDim: 8 })
    const { client, calls } = stubSequenced([[], [row()]])
    const snippet = 'the widget of'

    await searchExactSections(deps(client, { embedder }), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet,
      fileTokens: ['widget'],
    })

    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(4)
    // Both pairs share dispatchRoutes: the exact-file pair (0, 1) and
    // the fallback pair (2, 3) each carry the stripped text on the BM25
    // leg...
    for (const dispatch of [dispatches[1]!, dispatches[3]!]) {
      expect(dispatch.data).toEqual(['widget'])
    }
    // ...and every dense leg still carries the FULL snippet's vector.
    for (const dispatch of [dispatches[0]!, dispatches[2]!]) {
      expect(dispatch.data).toEqual([await embedder.embedQuery(snippet)])
    }
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
    // math, asserted at every score regardless of what the default cut
    // would keep.
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

    // minScore 0 keeps every rank visible for the math pin; the default
    // floor keeps rank 2 and drops rank 3 (see the floor goldens).
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
  it('keeps a hit whose -score equals the 5.0 floor and drops one below it', async () => {
    const { client } = stubMilvus({
      denseResults: [],
      sparseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1, score: -5.0 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B', score: -4.9999 }),
      ],
    })

    const results = await hybridSearch(deps(client), { query: 'x' })

    // -(-5.0) == 5.0 survives; -(-4.9999) < 5.0 drops.
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

describe('default fused-score floor (TASK-009 rule at 1/(k+2), TASK-007)', () => {
  // Fillers are single-route hits; ranks are positional, so a filler at
  // rank >= 3 fuses below the floor and is dropped. Unique section
  // headers keep them out of the source_path + section_header dedupe.
  function fillerRows(from: number, count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_unused, offset) => row({
      [MILVUS_FIELDS.chunkId]: from + offset,
      [MILVUS_FIELDS.sectionHeader]: `Filler ${from + offset}`,
    }))
  }

  it('keeps single-route rank-1 and rank-2-only hits plus both-route hits', async () => {
    // Fetched-window worst case: topK 20 with oversample 2 puts limit 40
    // on each route, so chunk 900 takes the window's last rank on BOTH
    // routes and still clears the floor at 2/(60+40) = 0.02 > 1/62.
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

    // 101 and 201 are single-route rank-1 hits; 102 and 202 sit at
    // exactly 1/62, the inclusive floor the TASK-007 value change set.
    // Fillers 103..139 and 203..239 fuse to 1/63 or lower and drop.
    expect(results.map((result) => result.chunk_id)).toEqual([900, 101, 201, 102, 202])
    expect(results[0]!.score).toBe(1 / 100 + 1 / 100)
    expect(results[1]!.score).toBe(1 / 61)
    expect(results[3]!.score).toBe(1 / 62)
  })

  it('drops a single-route rank-3-only hit at 1/63', async () => {
    const { client } = stubMilvus({
      denseResults: [
        row({ [MILVUS_FIELDS.chunkId]: 1 }),
        row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B' }),
        row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
      ],
      sparseResults: [],
    })

    // The boundary pin for the looser floor: rank 2 survives at exactly
    // 1/62, rank 3's 1/63 still drops.
    const results = await hybridSearch(deps(client), { query: 'x' })

    expect(results.map((result) => result.chunk_id)).toEqual([1, 2])
    expect(results[1]!.score).toBe(1 / 62)
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

    // The same fixture without minScore returns chunks 1 and 2: only
    // 1/63 sits under the 1/62 default floor.
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

    // Below the floor (1/62 ~ 0.016129): 0.0158 keeps chunk 3's 1/63
    // (0.015873), which the default drops.
    const relaxed = await hybridSearch(deps(client), { query: 'x', minScore: 0.0158 })
    expect(relaxed.map((result) => result.chunk_id)).toEqual([1, 2, 3])

    // Between the old 1/61 and the current 1/62 floor: 0.0162 cuts chunk
    // 2's 1/62 (0.016129), which the default keeps at equality.
    const tightened = await hybridSearch(deps(client), { query: 'x', minScore: 0.0162 })
    expect(tightened.map((result) => result.chunk_id)).toEqual([1])

    // Above it: 0.0164 also cuts chunk 1's 1/61 (0.016393), which the
    // default keeps, leaving nothing.
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
    // The explicit bound cuts rank 2; raw route scores never reach the
    // comparison.
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
      fileTokens: ['widget', 'src'],
    })

    expect(results).toHaveLength(1)
    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(4)
    for (const dispatch of dispatches.slice(0, 2)) {
      expect(dispatch.expr).toBe('source_path == "src/widget.tsx"')
    }
    for (const dispatch of dispatches.slice(2)) {
      expect(dispatch.expr)
        .toBe('ARRAY_CONTAINS(trigger_extensions, ".tsx") and ARRAY_CONTAINS_ANY(trigger_frameworks, ["react"]) and ARRAY_CONTAINS_ANY(wake_keywords, ["widget", "src"])')
    }
  })

  it('always carries the fileTokens wake-keyword clause (TASK-008)', async () => {
    const { client, calls } = stubSequenced([[], [row()]])

    await searchExactSections(deps(client), {
      filePath: 'notes/plain.md',
      fileTokens: ['src/', 'app/'],
      snippet: 'deployment notes',
    })

    const dispatches = searchDispatches(calls)
    expect(dispatches).toHaveLength(4)
    for (const dispatch of dispatches.slice(2)) {
      // Trailing separators are trimmed; the clause is no longer gated on
      // "nothing else narrows" (TASK-008).
      expect(dispatch.expr).toBe('ARRAY_CONTAINS_ANY(wake_keywords, ["src", "app"])')
    }
  })

  it('joins the wake-keyword clause with framework filters (TASK-008)', async () => {
    const { client, calls } = stubSequenced([[], [row()]])

    await searchExactSections(deps(client), {
      filePath: 'notes/plain.md',
      frameworks: ['milvus'],
      fileTokens: ['notes'],
      snippet: 'ops notes',
    })

    for (const dispatch of searchDispatches(calls).slice(2)) {
      expect(dispatch.expr)
        .toBe('ARRAY_CONTAINS_ANY(trigger_frameworks, ["milvus"]) and ARRAY_CONTAINS_ANY(wake_keywords, ["notes"])')
    }
  })

  it('skips the fallback without fileTokens that could intersect (TASK-008)', async () => {
    const { client, calls } = stubSequenced([[], [row()]])

    const results = await searchExactSections(deps(client), {
      filePath: 'notes/plain.md',
      ext: '.md',
      snippet: 'deployment notes',
    })

    // No possible intersection: the leg is skipped without dispatching.
    expect(results).toEqual([])
    expect(searchDispatches(calls)).toHaveLength(2)
  })

  // One page feeds both routes of a dispatch pair (stubSequenced), so a
  // score-0.85 row dies on the sparse -score cutoff and fuses as a
  // single-route dense hit at its positional rank: the production shape
  // for sub-floor candidates. Under the TASK-009 agreement floor only
  // chunk 1 (rank 1 on both routes) survives.
  const floorPage = [
    row({ [MILVUS_FIELDS.chunkId]: 1, [MILVUS_FIELDS.sectionHeader]: 'A' }),
    row({ [MILVUS_FIELDS.chunkId]: 2, [MILVUS_FIELDS.sectionHeader]: 'B', score: 0.85 }),
    row({ [MILVUS_FIELDS.chunkId]: 3, [MILVUS_FIELDS.sectionHeader]: 'C' }),
    row({ [MILVUS_FIELDS.chunkId]: 4, [MILVUS_FIELDS.sectionHeader]: 'D', score: 0.85 }),
  ]

  it('agreement-floors the fallback page: only the joint rank-1 survives (TASK-009)', async () => {
    const { client } = stubSequenced([[], floorPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
      fileTokens: ['widget'],
      k: 4,
    })

    // chunk 1 is rank 1 on both routes: exactly 2/61, the inclusive
    // agreement floor. chunk 2 is a single-route dense hit (tops out at
    // 1/61). chunk 3 is dense rank 3 + sparse rank 2: 1/63 + 1/62 < 2/61.
    // chunk 4's 1/64 is the furthest down. Agreement means agreement.
    expect(results.map((result) => result.chunk_id)).toEqual([1])
    expect(results[0]!.score).toBe(1 / 61 + 1 / 61)
  })

  it('lets an explicit fallback minScore of 0 disable the floor (TASK-014)', async () => {
    const { client } = stubSequenced([[], floorPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/widget.tsx',
      ext: '.tsx',
      snippet: 'widget lifecycle',
      fileTokens: ['widget'],
      k: 4,
      minScore: 0,
    })

    // The same page under the default floor drops chunk 4 only.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 3, 2, 4])
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
      row({
        [MILVUS_FIELDS.chunkId]: 3,
        [MILVUS_FIELDS.sourcePath]: 'src/app.tsx',
        [MILVUS_FIELDS.sectionHeader]: 'C',
        score: 0.85,
      }),
    ]
    const { client, calls } = stubSequenced([exactPage])

    const results = await searchExactSections(deps(client), {
      filePath: 'src/app.tsx',
      ext: '.tsx',
      k: 3,
    })

    // chunk 3's 1/63 is below the fallback floor; the exact page returns
    // it unfloored, and its non-empty answer skips the fallback.
    expect(results.map((result) => result.chunk_id)).toEqual([1, 2, 3])
    expect(searchDispatches(calls)).toHaveLength(2)
  })

  it('returns empty when both exact and fallback dispatches find nothing', async () => {
    const { client } = stubMilvus({ results: [] })

    const results = await searchExactSections(deps(client), {
      filePath: 'notes/missing.md',
      fileTokens: ['notes'],
    })

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
