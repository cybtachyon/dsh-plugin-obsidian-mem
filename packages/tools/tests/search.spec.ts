/**
 * memory_search behavior spec against a fake seam: request passthrough
 * (scopes/ext/topK/tokenCap), the budgets-derived default limit, the
 * tool-side snippet budget with its honest truncation flag, the ranked
 * section shape, the empty-result guidance, and the index_offline value
 * for an IndexOfflineError (never a throw).
 */

import { describe, expect, it } from 'vitest'

import { approxCharsForTokens, CHUNK_MAX_TOKENS, TOOL_MEMORY_SEARCH } from '../../core/lib/index.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import { createSearchTool, executeSearch, renderSearch } from '../src/index.ts'
import type { SearchValue } from '../src/index.ts'
import { createFakeService, matchesOutput } from './testkit.ts'

function sectionRows(): MemorySearchResult[] {
  return [
    {
      chunk_id: 'chunk-1',
      source_path: '/vaults/shared/markdown/deploys.md',
      section_header: 'Friday checklist',
      chunk_text: `${'release steps. '.repeat(10)}tail`,
      scope: 'global',
      vault: '/vaults/shared',
      mode: 'shared',
      updated_at: '2026-11-01',
      score: 0.8125,
    },
    {
      chunk_id: 'chunk-2',
      source_path: '/vaults/ro/markdown/legacy.md',
      section_header: 'Old host names',
      chunk_text: 'app.example.com fronts the API.',
      scope: 'reference',
      vault: '/vaults/ro',
      mode: 'read-only',
      updated_at: '2026-10-01',
      score: 0.42,
    },
  ]
}

function makeService(searchResults: MemorySearchResult[] = sectionRows()) {
  return createFakeService({
    vaults: [],
    searchResults,
    budgets: { searchTopK: 4, readSectionTokens: 10 },
  })
}

function search(service: ReturnType<typeof makeService>, args: Record<string, unknown>): Promise<SearchValue> {
  return executeSearch(service, args) as Promise<SearchValue>
}

describe('memory_search execution', () => {
  it('maps ranked sections with mode, score, and snippet truncation', async () => {
    const service = makeService()
    const value = await search(service, { query: 'deploy checklist' })
    expect(value.kind).toBe('search')
    if (value.kind !== 'search') return
    expect(value.count).toBe(2)
    expect(value.sections[0]).toEqual({
      path: '/vaults/shared/markdown/deploys.md',
      section_header: 'Friday checklist',
      scope: 'global',
      vault: '/vaults/shared',
      vault_mode: 'shared',
      score: 0.8125,
      snippet: 'release steps. '.repeat(10).concat('tail').slice(0, approxCharsForTokens(10)),
      snippet_truncated: true,
    })
    expect(value.sections[1]?.snippet_truncated).toBe(false)
    expect(value.notice).toBeUndefined()
    expect(matchesOutput(createSearchTool(service), value)).toEqual([])
  })

  it('passes scope, ext, limit, and the dispatch snippet budget through', async () => {
    const service = makeService([])
    await search(service, { query: 'hosts', scope: 'domain', ext: '.tsx', limit: 3 })
    expect(service.searchRequests[0]).toEqual({
      query: 'hosts',
      scopes: ['domain'],
      ext: '.tsx',
      topK: 3,
      tokenCap: CHUNK_MAX_TOKENS,
    })
  })

  it('defaults the limit to the resolved search budget and clamps the range', async () => {
    const service = makeService([])
    await search(service, { query: 'a' })
    await search(service, { query: 'b', limit: 500 })
    expect(service.searchRequests[0]?.topK).toBe(4)
    expect(service.searchRequests[1]?.topK).toBe(20)
  })

  it('reports unknown vault mode when the registry no longer knows the vault', async () => {
    const rows = sectionRows()
    rows[1] = { ...rows[1]!, mode: null }
    const service = makeService(rows)
    const value = await search(service, { query: 'hosts' })
    if (value.kind !== 'search') throw new Error('unexpected kind')
    expect(value.sections[1]?.vault_mode).toBe('unknown')
  })

  it('maps an offline index to the index_offline value with remediation', async () => {
    const service = createFakeService({
      vaults: [],
      searchError: new IndexOfflineError('memory index is offline: milvus start failed'),
    })
    const value = await search(service, { query: 'anything' })
    expect(value.kind).toBe('index_offline')
    if (value.kind !== 'index_offline') return
    expect(value.message).toContain('milvus start failed')
    expect(value.remediation).toContain('Retry the search')
    expect(matchesOutput(createSearchTool(service), value)).toEqual([])

    const text = renderSearch(value)
    expect(text).toContain('Memory search is unavailable: memory index is offline')
    expect(text).toContain('Retry the search once more')
  })

  it('carries the one-time default-vault notice on the first value', async () => {
    const service = createFakeService({
      vaults: [],
      searchResults: [],
      notice: 'Default vault ready at /home/tester/.dsh/obsidian-mem.',
    })
    const first = await search(service, { query: 'a' })
    const second = await search(service, { query: 'a' })
    expect(first.notice).toBe('Default vault ready at /home/tester/.dsh/obsidian-mem.')
    expect('notice' in second).toBe(false)
  })

  it('throws out of protocol only for unexpected dispatch failures', async () => {
    const service = createFakeService({
      vaults: [],
      searchError: new Error('milvus driver exploded'),
    })
    await expect(executeSearch(service, { query: 'a' })).rejects.toThrow('driver exploded')
  })

  it('requires a query argument', async () => {
    await expect(executeSearch(makeService(), {})).rejects.toThrow(/query/)
  })
})

describe('memory_search rendering', () => {
  const tool = createSearchTool(makeService())

  it('numbers sections with their retrieval identifiers and scores', async () => {
    const value = await search(makeService(), { query: 'deploy checklist' })
    const text = renderTool(value)
    expect(text).toContain(`1. /vaults/shared/markdown/deploys.md # ${'Friday checklist'}`)
    expect(text).toContain('score 0.8125')
    expect(text).toContain('vault /vaults/shared [shared]')
    expect(text).toContain('[section snippet truncated]')
    expect(text).toContain('2. /vaults/ro/markdown/legacy.md')
  })

  it('omits the header separator when a note has no section header', async () => {
    const headerless = [{ ...sectionRows()[0]!, section_header: '' }]
    const value = await search(makeService(headerless), { query: 'deploy' })
    const text = renderTool(value)
    expect(text).toContain('1. /vaults/shared/markdown/deploys.md\n')
    expect(text).not.toContain('deploys.md #')
  })

  it('answers the empty result with guidance', async () => {
    const value = await search(makeService([]), { query: 'nothing matches' })
    const text = renderTool(value)
    expect(text).toContain('No memory sections matched "nothing matches".')
    expect(text).toContain('memory_write')
  })

  it('prepends the notice once', async () => {
    const service = createFakeService({
      vaults: [],
      searchResults: [],
      notice: 'Default vault ready at /home/tester/.dsh/obsidian-mem.',
    })
    const value = await search(service, { query: 'a' })
    const text = renderTool(value)
    expect(text.startsWith('Default vault ready at /home/tester/.dsh/obsidian-mem.\n\n')).toBe(true)
    expect(TOOL_MEMORY_SEARCH).toBe('memory_search')
  })

  function renderTool(value: SearchValue): string {
    return tool.output.render({}, value as never)[0]?.text ?? ''
  }
})
