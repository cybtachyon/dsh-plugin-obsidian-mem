import { describe, expect, it } from 'vitest'
import { MILVUS_ARRAY_CAPACITIES, MILVUS_ARRAY_ELEMENT_MAX_LENGTHS } from '../src/constants.ts'
import { extractTriggers, normalizeExtension } from '../src/triggers.ts'

/**
 * Trigger-heuristic spec for the core module TASK-023 depends on:
 * fenced-block language and inline-path extension signals, frontmatter
 * overrides for extensions and frameworks, presence-gated framework
 * vocabulary plus manifest vocabulary, wake keywords from headers,
 * emphasis, frontmatter keywords, the note file-name slug, the chunker
 * header-path line, the non-generic intent markers, and the maximal Han
 * runs of the chunk text (TASK-017), with dedupe, lowercasing, and the
 * constants' capacity caps. Wake-key legality (TASK-014) drops the
 * generic house-format labels (why, how to apply, bare interrogatives),
 * fragment shapes (digit- or symbol-led keys, unbalanced brackets,
 * em-dash splices), and Han runs that are entirely standalone
 * function-word characters.
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
  it('collects frontmatter keywords, file words, headers, bold, emphasis, and kept intent markers', () => {
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
    expect(found).not.toContain('how')
    expect(found).toContain('debug')
    expect(new Set(found).size).toBe(found.length)
  })

  it('drops the house-format intent labels and bare interrogatives from every path', () => {
    const text = [
      '## Why',
      '',
      '**Why:** the gate needs wake keys.',
      '**How to apply:** run the probe first, then decide when it is safe.',
      'What this proves: where the rows die, who pays, how often, how deep.',
    ].join('\n')

    const found = keywords(text)

    for (const generic of ['who', 'what', 'when', 'where', 'why', 'how', 'how to apply']) {
      expect(found).not.toContain(generic)
    }

    // Frontmatter keywords run through the same legality filter.
    const authored = keywords('plain prose here.', { keywords: ['how', 'why', 'billing'] })
    expect(authored).not.toContain('how')
    expect(authored).not.toContain('why')
    expect(authored).toContain('billing')
  })

  it('keeps non-generic intent markers when the text names them', () => {
    const found = keywords('investigate the flake, then troubleshoot it, and debug the runner')

    expect(found).toContain('investigate')
    expect(found).toContain('troubleshoot')
    expect(found).toContain('debug')
  })

  it('bounds wake-key shape: no digit- or symbol-led keys, unbalanced brackets, or em-dash splices', () => {
    const text = [
      '**0 of 54** and **2/(k+1** and **+ `field.field`** are fragments.',
      '**attendee chart cropping — resolved by t9b (2026-11-10** is a cut.',
      '**dialog open flow (ordering** is unbalanced.',
      'But **c++**, **node.js**, and **dsh-plugin** are terms.',
    ].join('\n')

    const found = keywords(text)

    expect(found).not.toContain('0 of 54')
    expect(found).not.toContain('2/(k+1')
    expect(found.some((keyword) => keyword.includes('field.field'))).toBe(false)
    expect(found.some((keyword) => keyword.includes('attendee chart cropping'))).toBe(false)
    expect(found.some((keyword) => keyword.includes('dialog open flow'))).toBe(false)
    expect(found.every((keyword) => /^\p{L}/u.test(keyword))).toBe(true)
    expect(found.every((keyword) => !keyword.includes('—'))).toBe(true)
    expect(found).toContain('c++')
    expect(found).toContain('node.js')
    expect(found).toContain('dsh-plugin')
  })

  it('takes wake words from the note file-name slug', () => {
    const found = extractTriggers({
      sectionText: 'plain prose with no header, bold, or emphasis at all.',
      filePath: 'drupal/drupal-route-normalizer-301-on-ajax-subpaths.md',
    }).wake_keywords

    expect(found).toContain('drupal')
    expect(found).toContain('route')
    expect(found).toContain('normalizer')
    expect(found).toContain('ajax')
    expect(found).toContain('subpaths')
    expect(found).not.toContain('301')
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

describe('wake_keywords: Han run harvest (TASK-017)', () => {
  it('harvests maximal Han runs after the existing wake entries, deduped', () => {
    const text = [
      '## Zh copy rules',
      '',
      'Obsidian Mem 是一款插件，可将你的知识库用作智能体（Agent）的共享记忆。',
      'The run 记忆 appears twice: 记忆 again.',
    ].join('\n')

    const found = keywords(text)

    expect(found).toContain('是一款插件')
    expect(found).toContain('可将你的知识库用作智能体')
    expect(found).toContain('的共享记忆')
    expect(found).toContain('记忆')
    // Existing entries keep first position; the runs fill in after them
    // in discovery order.
    const zhCopyIndex = found.indexOf('zh copy rules')
    expect(zhCopyIndex).toBeGreaterThanOrEqual(0)
    const runIndexes = ['是一款插件', '可将你的知识库用作智能体', '的共享记忆', '记忆'].map(
      (run) => found.indexOf(run),
    )
    expect(runIndexes).toEqual([...runIndexes].sort((a, b) => a - b))
    for (const runIndex of runIndexes) {
      expect(runIndex).toBeGreaterThan(zhCopyIndex)
    }
    expect(found.filter((keyword) => keyword === '记忆')).toHaveLength(1)
    // Maximal-run shape: sub-tokens and cross-run joins are never stored.
    expect(found).not.toContain('共享记忆')
    expect(found).not.toContain('记忆记忆')
  })

  it('keeps maximal-run shape: adjacent Han is one key, never sub-tokens', () => {
    const found = keywords('记忆记忆 智能体记忆')

    expect(found).toContain('记忆记忆')
    expect(found).toContain('智能体记忆')
    expect(found).not.toContain('记忆')
    expect(found).not.toContain('智能体')
  })

  it('drops runs made only of standalone Han function-word characters', () => {
    const found = keywords('他说，是的，我们的，时代。')

    expect(found).toContain('他说')
    expect(found).toContain('时代')
    expect(found).not.toContain('是的')
    expect(found).not.toContain('我们的')
  })

  it('applies the function-run drop to frontmatter keywords too (one legality gate)', () => {
    const found = keywords('plain prose here.', { keywords: ['记忆', '是的'] })

    expect(found).toContain('记忆')
    expect(found).not.toContain('是的')
  })

  it('existing entries keep priority when the column fills; Han runs fill the rest', () => {
    const cap = MILVUS_ARRAY_CAPACITIES.wakeKeywords
    const meta = { keywords: Array.from({ length: cap - 2 }, (_, i) => `keyword ${i}`) }

    const found = keywords('智能体 记忆 的共享记忆', meta)

    expect(found).toHaveLength(cap)
    expect(found.slice(-2)).toEqual(['智能体', '记忆'])
    expect(found).not.toContain('的共享记忆')
  })

  it('caps a Han run at the wakeKeywords element max length', () => {
    const cap = MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords
    const fits = '记'.repeat(cap)
    const over = '记'.repeat(cap + 1)

    const found = keywords(`${fits} ${over}`)

    expect(found).toContain(fits)
    expect(found).not.toContain(over)
  })

  it('leaves a Latin-only note’s wake array unchanged and Han-free', () => {
    const found = extractTriggers({
      sectionText: 'The route normalizer strips ajax subpaths.',
      filePath: 'drupal/drupal-route-normalizer-301-on-ajax-subpaths.md',
    }).wake_keywords

    // The exact TASK-002 collision-row shape: Latin slug words only,
    // byte-identical to the pre-Task-017 output.
    expect(found).toEqual(['drupal', 'route', 'normalizer', 'on', 'ajax', 'subpaths'])
    expect(found.every((keyword) => !/\p{Script=Han}/u.test(keyword))).toBe(true)
  })
})

describe('normalizeExtension: the canonical trigger-extension spelling', () => {
  it('renders one dotted lowercase form for every accepted spelling', () => {
    expect(normalizeExtension('.ts')).toBe('.ts')
    expect(normalizeExtension('TS')).toBe('.ts')
    expect(normalizeExtension(' .TSX ')).toBe('.tsx')
    expect(normalizeExtension('..md')).toBe('.md')
    expect(normalizeExtension('c++')).toBe('.c++')
  })

  it('returns null for anything that is not an extension', () => {
    expect(normalizeExtension('')).toBeNull()
    expect(normalizeExtension('.')).toBeNull()
    expect(normalizeExtension('...')).toBeNull()
    expect(normalizeExtension('   ')).toBeNull()
  })

  it('stores override spellings through the same normalizer a filter uses', () => {
    const found = extractTriggers({
      sectionText: 'plain text',
      filePath: 'notes/a.md',
      noteMeta: { trigger_extensions: [' TS ', '.Vue'] },
    }).trigger_extensions

    expect(found).toEqual(['.ts', '.vue'])
  })
})

describe('per-column element caps', () => {
  it('drops wake keywords past the wakeKeywords element cap only', () => {
    const tooLong = 'k'.repeat(MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords + 1)

    const found = keywords(`**${tooLong}** **kept**`)

    expect(found).not.toContain(tooLong.toLowerCase())
    expect(found).toContain('kept')
  })

  it('drops extensions whose dotted form passes the triggerExtensions element cap', () => {
    const cap = MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerExtensions
    const fits = `.ts`
    const overCap = `.${'z'.repeat(cap)}` // dotted form is cap + 1 chars

    const found = extractTriggers({
      sectionText: 'plain text',
      filePath: 'notes/a.md',
      noteMeta: { trigger_extensions: [fits, overCap] },
    }).trigger_extensions

    expect(found).toEqual([fits])
  })
})
