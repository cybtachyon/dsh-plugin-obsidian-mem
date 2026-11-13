import { describe, expect, it } from 'vitest'
import { MILVUS_ARRAY_CAPACITIES } from '../src/constants.ts'
import { extractTriggers } from '../src/triggers.ts'

/**
 * Trigger-heuristic spec for the core module TASK-023 depends on:
 * fenced-block language and inline-path extension signals, frontmatter
 * overrides for extensions and frameworks, presence-gated framework
 * vocabulary plus manifest vocabulary, wake keywords from headers,
 * emphasis, frontmatter keywords, the chunker header-path line, and
 * intent markers, with dedupe, lowercasing, and the constants' capacity
 * caps.
 */

function ext(text: string, filePath = 'notes/a.md'): string[] {
  return extractTriggers({ sectionText: text, filePath }).trigger_extensions
}

function frameworks(text: string, vocabulary?: readonly string[]): string[] {
  return extractTriggers({
    sectionText: text,
    filePath: 'notes/a.md',
    ...(vocabulary ? { manifestVocabulary: { frameworks: vocabulary } } : {}),
  }).trigger_frameworks
}

function keywords(text: string, noteMeta?: Record<string, unknown>): string[] {
  return extractTriggers({ sectionText: text, filePath: 'notes/a.md', ...(noteMeta ? { noteMeta } : {}) })
    .wake_keywords
}

describe('trigger_extensions', () => {
  it('maps fenced-block languages to extensions and ignores non-file fences', () => {
    const text = [
      'Some notes.',
      '',
      '```ts',
      'const x: number = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '```python',
      'print(1)',
      '```',
    ].join('\n')

    expect(ext(text)).toEqual(['.ts', '.py'])
  })

  it('collects inline file paths with known extensions only', () => {
    const text = 'edit vite.config.mts and src/app.tsx, see https://example.com/x and version 1.2.3'

    expect(ext(text)).toEqual(['.mts', '.tsx'])
  })

  it('reads the trigger_extensions frontmatter override wholesale', () => {
    const text = '```ts\nconst x = 1\n```'

    expect(extractTriggers({
      noteMeta: { trigger_extensions: ['vue', ' .SVELTE'] },
      sectionText: text,
      filePath: 'notes/a.md',
    }).trigger_extensions).toEqual(['.vue', '.svelte'])
  })

  it('takes a known extension from the note file name itself', () => {
    expect(ext('plain prose only', 'notes/server.ts.md')).toEqual(['.ts'])
  })

  it('caps the list at the collection max_capacity', () => {
    const override = Array.from({ length: 100 }, (_, i) => `e${i}`)

    expect(extractTriggers({
      noteMeta: { trigger_extensions: override },
      sectionText: '',
      filePath: 'notes/a.md',
    }).trigger_extensions).toHaveLength(MILVUS_ARRAY_CAPACITIES.triggerExtensions)
  })

  it('returns empty arrays for empty input', () => {
    expect(extractTriggers({ sectionText: '', filePath: 'a.md' })).toEqual({
      trigger_extensions: [],
      trigger_frameworks: [],
      wake_keywords: [],
    })
  })
})

describe('trigger_frameworks', () => {
  it('detects known frameworks by word presence, canonical and lowercase', () => {
    expect(frameworks('Migrate the Next.js app off React 17')).toEqual(['react', 'next'])
  })

  it('applies manifest vocabulary only when the section text names the framework', () => {
    expect(frameworks('nothing relevant here', ['solidjs'])).toEqual([])
    expect(frameworks('we adopted solidjs last sprint', ['solidjs'])).toEqual(['solidjs'])
  })

  it('skips word-boundary near misses', () => {
    expect(frameworks('the springfield report')).toEqual([])
  })

  it('uses the trigger_frameworks frontmatter override wholesale', () => {
    const result = extractTriggers({
      noteMeta: { trigger_frameworks: ['Custom-FW', 'react'] },
      sectionText: 'mentions nothing',
      filePath: 'notes/a.md',
    }).trigger_frameworks

    expect(result).toEqual(['custom-fw', 'react'])
  })
})

describe('wake_keywords', () => {
  it('collects frontmatter keywords, headers, bold, emphasis, and intent markers', () => {
    const text = [
      '## Debugging crashes',
      '',
      'The **Rate Limiter** uses *token bucket* accounting.',
      'How to debug: read the counter first.',
    ].join('\n')

    const found = keywords(text, { keywords: ['Billing', 'rate limiter'] })

    expect(found.slice(0, 2)).toEqual(['billing', 'rate limiter'])
    expect(found).toContain('debugging crashes')
    expect(found).toContain('rate limiter')
    expect(found).toContain('token bucket')
    expect(found).toContain('how')
    expect(found).toContain('debug')
    expect(new Set(found).size).toBe(found.length)
  })

  it('splits the chunker header-path first line into segments', () => {
    expect(keywords('Setup > Flags\ncontent here')).toContain('setup')
    expect(keywords('Setup > Flags\ncontent here')).toContain('flags')
  })

  it('does not treat an identifier underscore as emphasis', () => {
    expect(keywords('use max_retry_count here')).not.toContain('retry')
  })

  it('drops too-short, over-long, and runaway-sentence keywords', () => {
    const sentence = 'this keyword candidate is far too many words to behave like one keyword at all'
    const long = 'x'.repeat(65)

    const found = keywords(`**${long}** **${sentence}** **ab**`)

    expect(found).toContain('ab')
    expect(found).not.toContain(long.toLowerCase())
    expect(found).not.toContain(sentence.toLowerCase())
  })

  it('caps the list at the collection max_capacity', () => {
    const meta = { keywords: Array.from({ length: 150 }, (_, i) => `keyword ${i}`) }

    expect(keywords('plain text', meta)).toHaveLength(MILVUS_ARRAY_CAPACITIES.wakeKeywords)
  })

  it('is deterministic across runs', () => {
    const text = '# Alpha\n\n**beta** gamma *delta* how debug'

    expect(keywords(text)).toEqual(keywords(text))
  })
})
