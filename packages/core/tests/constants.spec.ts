import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_HISTORY_SUFFIX,
  approxCharsForTokens,
  approxTokens,
  CHUNK_MAX_TOKENS,
  dbDir,
  dbFile,
  DEFAULT_MODEL_ID,
  defaultVaultPath,
  DREAMS_FILE,
  GLOBAL_MEMORY_TOKENS,
  INTENTS_FILE,
  INTENT_MARKERS,
  isIntentMarker,
  isReservedNonIndexed,
  isScopeSlug,
  isScopeType,
  isVectorDim,
  MEMORY_TOOL_NAMES,
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
  MILVUS_SCALAR_MAX_LENGTHS,
  modelCacheDir,
  PASSAGE_PREFIX,
  PLUGIN_SOURCE_KIND,
  QUERY_PREFIX,
  RECALL_READ_MAX_SECTIONS,
  RECALL_READ_SECTION_TOKENS,
  RECALL_TURN_START_TOKENS,
  RECALLED_CLOSE,
  RECALLED_OPEN,
  RESERVED_NON_INDEXED,
  SCOPE_DOMAIN,
  SCOPE_GLOBAL,
  SCOPE_REFERENCE,
  SEARCH_DEFAULT_TOP_K,
  SEARCH_MAX_RESULTS,
  stateDir,
  SYSTEM_PROMPT_SECTION_NAME,
  SYSTEM_PROMPT_SECTION_ORDER,
  TOOL_MEMORY_AUDIT,
  TOOL_MEMORY_DREAM,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_SEARCH,
  TOOL_MEMORY_WRITE,
  TRANSFORMERS_PIPELINE_OPTIONS,
  unwrapRecalled,
  VAULT_MARKDOWN_DIR,
  VAULT_METADATA_DIR,
  VECTOR_DIM_DEFAULT,
  wrapRecalled,
} from '../src/constants.ts'

/**
 * Constants + pure-helper spec for TASK-010: the values the whole plugin
 * trusts verbatim, and the wrapper/slug/dimension helpers built on them.
 */
describe('intent markers', () => {
  it('lists the nine canonical markers in order', () => {
    expect(INTENT_MARKERS).toEqual([
      'who', 'what', 'when', 'where', 'how', 'why',
      'investigate', 'debug', 'troubleshoot',
    ])
    expect(INTENT_MARKERS).toHaveLength(9)
    expect(new Set(INTENT_MARKERS).size).toBe(9)
  })

  it('recognizes marker names and rejects others', () => {
    expect(isIntentMarker('troubleshoot')).toBe(true)
    expect(isIntentMarker('investigate')).toBe(true)
    expect(isIntentMarker('which')).toBe(false)
    expect(isIntentMarker('')).toBe(false)
  })
})

describe('scope values', () => {
  it('names the three scope constants distinctly', () => {
    expect([SCOPE_GLOBAL, SCOPE_DOMAIN, SCOPE_REFERENCE])
      .toEqual(['global', 'domain', 'reference'])
  })

  it('accepts kebab-case project slugs', () => {
    expect(isScopeSlug('obsidian-mem')).toBe(true)
    expect(isScopeSlug('x')).toBe(true)
    expect(isScopeSlug('a1-b2-c3')).toBe(true)
  })

  it('rejects malformed slugs', () => {
    expect(isScopeSlug('')).toBe(false)
    expect(isScopeSlug('-lead')).toBe(false)
    expect(isScopeSlug('trail-')).toBe(false)
    expect(isScopeSlug('double--hyphen')).toBe(false)
    expect(isScopeSlug('Upper')).toBe(false)
    expect(isScopeSlug('with space')).toBe(false)
    expect(isScopeSlug('snake_case')).toBe(false)
  })

  it('accepts named scopes and slugs in isScopeType', () => {
    expect(isScopeType(SCOPE_GLOBAL)).toBe(true)
    expect(isScopeType(SCOPE_DOMAIN)).toBe(true)
    expect(isScopeType(SCOPE_REFERENCE)).toBe(true)
    expect(isScopeType('dsh-plugin')).toBe(true)
    expect(isScopeType('Not A Slug')).toBe(false)
  })
})

describe('vault layout and reserved files', () => {
  it('names the two vault subdirs', () => {
    expect(VAULT_MARKDOWN_DIR).toBe('markdown')
    expect(VAULT_METADATA_DIR).toBe('metadata')
  })

  it('lists the reserved root files and covers the suffix rule', () => {
    expect(RESERVED_NON_INDEXED).toEqual([INTENTS_FILE, DREAMS_FILE])
    expect(ARCHIVE_HISTORY_SUFFIX).toBe('_history.md')
    expect(isReservedNonIndexed('.INTENTS.md')).toBe(true)
    expect(isReservedNonIndexed('DREAMS.md')).toBe(true)
    expect(isReservedNonIndexed(`pricing-model${ARCHIVE_HISTORY_SUFFIX}`)).toBe(true)
    expect(isReservedNonIndexed('pricing-model.md')).toBe(false)
  })
})

describe('default paths', () => {
  const homedir = '/home/tester'

  it('anchors every location under the injected homedir', () => {
    expect(defaultVaultPath(homedir)).toBe(`${homedir}/.dsh/obsidian-mem`)
    expect(dbDir(homedir)).toBe(`${homedir}/.dsh/obsidian-mem-db`)
    expect(dbFile(homedir)).toBe(`${homedir}/.dsh/obsidian-mem-db/memory.db`)
    expect(modelCacheDir(homedir)).toBe(`${homedir}/.dsh/obsidian-mem/models`)
    expect(stateDir(homedir)).toBe(`${homedir}/.dsh/obsidian-mem-db/state`)
  })

  it('never leaks past the injected homedir', () => {
    expect(defaultVaultPath('/alt/home')).toBe('/alt/home/.dsh/obsidian-mem')
    expect(stateDir('/alt/home')).toContain('/alt/home')
  })
})

describe('recalled-memory wrappers', () => {
  it('builds the open and close tags around a source path', () => {
    expect(RECALLED_OPEN('/vault/markdown/a.md'))
      .toBe('<recalled_memory source="/vault/markdown/a.md">')
    expect(RECALLED_CLOSE).toBe('</recalled_memory>')
  })

  it('round-trips wrapRecalled through unwrapRecalled', () => {
    const source = '/vaults/team/markdown/topic.md'
    const body = '# Topic\n\nSome recalled lines.'
    expect(unwrapRecalled(wrapRecalled(source, body))).toEqual({ source, body })
  })

  it('escapes attribute-hostile paths through the round trip', () => {
    const source = '/weird/"><escape>&.md'
    const wrapped = wrapRecalled(source, 'body')
    expect(wrapped).toContain('&quot;&gt;&lt;escape&gt;&amp;')
    expect(unwrapRecalled(wrapped)).toEqual({ source, body: 'body' })
  })

  it('returns null for text that is not a whole wrapped segment', () => {
    expect(unwrapRecalled('plain text')).toBeNull()
    expect(unwrapRecalled(`${RECALLED_OPEN('/a.md')}\nbody`)).toBeNull()
    expect(unwrapRecalled(`inner\n${RECALLED_CLOSE}`)).toBeNull()
  })
})

describe('tool names and identity', () => {
  it('names the five memory tools', () => {
    expect(MEMORY_TOOL_NAMES).toEqual([
      TOOL_MEMORY_READ, TOOL_MEMORY_SEARCH, TOOL_MEMORY_WRITE,
      TOOL_MEMORY_DREAM, TOOL_MEMORY_AUDIT,
    ])
    expect(MEMORY_TOOL_NAMES).toEqual([
      'memory_read', 'memory_search', 'memory_write',
      'memory_dream', 'memory_audit',
    ])
  })

  it('carries the message source kind and prompt section identity', () => {
    expect(PLUGIN_SOURCE_KIND).toBe('plugin:obsidian-mem')
    expect(SYSTEM_PROMPT_SECTION_NAME).toBe('obsidian-mem')
    expect(SYSTEM_PROMPT_SECTION_ORDER).toBe(9600)
  })
})

describe('budget defaults', () => {
  it('carries the plan-specified budgets', () => {
    expect(RECALL_TURN_START_TOKENS).toBe(1200)
    expect(RECALL_READ_SECTION_TOKENS).toBe(350)
    expect(RECALL_READ_MAX_SECTIONS).toBe(2)
    expect(GLOBAL_MEMORY_TOKENS).toBe(1500)
    expect(SEARCH_DEFAULT_TOP_K).toBe(6)
    expect(SEARCH_MAX_RESULTS).toBe(20)
    expect(CHUNK_MAX_TOKENS).toBe(500)
  })

  it('estimates tokens at four chars each, rounding up', () => {
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abcd')).toBe(1)
    expect(approxTokens('abcde')).toBe(2)
    expect(approxTokens('x'.repeat(400))).toBe(100)
  })
})

describe('milvus and embedder identifiers', () => {
  it('names the collection and every schema field', () => {
    expect(MILVUS_COLLECTION).toBe('obsidian_mem')
    expect(Object.values(MILVUS_FIELDS).sort()).toEqual([
      'chunk_id', 'chunk_text', 'dense_vector', 'scope', 'section_header',
      'source_path', 'sparse', 'trigger_extensions', 'trigger_frameworks',
      'updated_at', 'vault', 'wake_keywords',
    ])
  })

  it('defaults to the 384-d model width with lossy opt-ins only', () => {
    expect(VECTOR_DIM_DEFAULT).toBe(384)
    expect(isVectorDim(384)).toBe(true)
    expect(isVectorDim(128)).toBe(true)
    expect(isVectorDim(192)).toBe(true)
    expect(isVectorDim(256)).toBe(true)
    expect(isVectorDim(320)).toBe(true)
    expect(isVectorDim(300)).toBe(false)
    expect(isVectorDim(768)).toBe(false)
    expect(isVectorDim(0)).toBe(false)
  })

  it('carries the e5-small id, prefixes, and v4 pipeline options', () => {
    expect(DEFAULT_MODEL_ID).toBe('Xenova/multilingual-e5-small')
    expect(PASSAGE_PREFIX).toBe('passage: ')
    expect(QUERY_PREFIX).toBe('query: ')
    expect(TRANSFORMERS_PIPELINE_OPTIONS).toEqual({
      pooling: 'mean',
      normalize: true,
      dtype: 'q8',
    })
  })
})

describe('column widths and budgets shared across layers', () => {
  it('declares one max_length per scalar VarChar column', () => {
    expect(MILVUS_SCALAR_MAX_LENGTHS).toEqual({
      sourcePath: 1024,
      sectionHeader: 512,
      chunkText: 65_535,
      vault: 256,
      scope: 64,
    })
  })

  it('names the one consistency level both sides of a read pin', () => {
    expect(MILVUS_CONSISTENCY_LEVEL).toBe('Strong')
  })

  it('converts a token budget to the char cut approxTokens reads back', () => {
    expect(approxCharsForTokens(50)).toBe(200)
    expect(approxCharsForTokens(350)).toBe(1400)
    expect(approxCharsForTokens(2.9)).toBe(8)
    // A zero or negative budget still shows one token worth of text.
    expect(approxCharsForTokens(0)).toBe(4)
    expect(approxCharsForTokens(-10)).toBe(4)
    for (const tokens of [1, 5, 50, 350]) {
      expect(approxTokens('x'.repeat(approxCharsForTokens(tokens)))).toBe(tokens)
    }
  })
})
