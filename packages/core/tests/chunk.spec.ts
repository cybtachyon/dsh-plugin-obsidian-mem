import { describe, expect, it } from 'vitest'
import { approxTokens } from '../src/constants.ts'
import { chunkMarkdown, splitLongChunk, stripNoise } from '../src/chunk.ts'
import type { Chunk } from '../src/chunk.ts'

/**
 * Chunker spec for TASK-013: the ported MarkdownHeaderTextSplitter
 * (docs/research/milvus-transformers-findings.md §7) under nested
 * headers, code fences, front matter, blank-line flushes, and the
 * "  \n" aggregation join, plus the secondary long-chunk split,
 * stable header_hash values, and the embed-time noise stripper.
 */

function chunkOne(sourcePath: string, lines: readonly string[]): Chunk[] {
  return chunkMarkdown({ source_path: sourcePath, text: lines.join('\n') })
}

describe('chunkMarkdown: header state machine (§7)', () => {
  it('splits nested headers with popped siblings and level paths', () => {
    const chunks = chunkOne('notes/a.md', [
      '# Alpha',
      'Alpha intro',
      '',
      '## Beta',
      'Beta text',
      '',
      '### Gamma',
      'Gamma text',
      '',
      '## Beta2',
      'Beta2 text',
    ])

    expect(chunks.map((chunk) => chunk.section_header)).toEqual([
      'Alpha',
      'Alpha > Beta',
      'Alpha > Beta > Gamma',
      'Alpha > Beta2',
    ])
    // "## Beta2" popping removed the Gamma key: Beta2 carries no deeper path.
    expect(chunks[3]?.chunk_text).toBe('Alpha > Beta2\nBeta2 text')
  })

  it('flushes pre-header content with the pre-header metadata snapshot', () => {
    // No blank line before "## B": "intro" must keep section "A", not
    // "A > B" (metadata was snapshotted before B mutated the stack).
    const chunks = chunkOne('a.md', ['# A', 'intro', '## B', 'btext'])
    expect(chunks[0]?.section_header).toBe('A')
    expect(chunks[0]?.chunk_text).toBe('A\nintro')
    expect(chunks[1]?.chunk_text).toBe('A > B\nbtext')
  })

  it('keeps # inside code fences out of the header stack', () => {
    const chunks = chunkOne('py.md', [
      '# Title',
      '',
      '```python',
      '# not a header',
      'x = 1',
      '```',
      '',
      'after fence',
    ])

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.section_header).toBe('Title')
    // Fence lines stay in stored text; the blank line between the fence
    // and "after fence" is lost to the "  \n" join.
    expect(chunks[0]?.chunk_text).toBe(
      'Title\n```python\n# not a header\nx = 1\n```  \nafter fence',
    )
  })

  it('tracks ~~~ fences symmetrically', () => {
    const chunks = chunkOne('t.md', ['## S', '', '~~~', '# inside', '~~~', '', 'after'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunk_text).toBe('S\n~~~\n# inside\n~~~  \nafter')
  })

  it('treats a single line holding both fences as content, not a block', () => {
    // count("```") === 1 rule: this line does not open a block, so the
    // following header is a header.
    const chunks = chunkOne('one.md', ['# T', '', '```js code ```', '# Real Header', 'body'])
    expect(chunks.map((chunk) => chunk.section_header)).toEqual(['T', 'Real Header'])
    expect(chunks[0]?.chunk_text).toBe('T\n```js code ```')
  })

  it('treats "#Header" without a space as content', () => {
    const chunks = chunkOne('n.md', ['## S', '', '#Header x', 'more'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.section_header).toBe('S')
    expect(chunks[0]?.chunk_text).toBe('S\n#Header x\nmore')
  })

  it('accepts a bare "#" header and drops its empty text from the path', () => {
    const chunks = chunkOne('bare.md', ['#', 'body'])
    expect(chunks[0]?.section_header).toBe('')
    expect(chunks[0]?.chunk_text).toBe('body')
  })

  it('falls an unconfigured level through to content', () => {
    const chunks = chunkMarkdown(
      { source_path: 'p.md', text: ['# A', '', '### deep', 'text'].join('\n') },
      { headers: [{ token: '#', name: 'H1' }, { token: '##', name: 'H2' }] },
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.section_header).toBe('A')
    expect(chunks[0]?.chunk_text).toBe('A\n### deep\ntext')
  })

  it('keeps both keys when levels skip (# then ###)', () => {
    const chunks = chunkOne('skip.md', ['# A', '', '### C', 'text'])
    expect(chunks[0]?.section_header).toBe('A > C')
  })

  it('joins same-metadata runs with the hard break and loses blank lines', () => {
    const chunks = chunkOne('p.md', ['## S', '', 'first para', '', 'second para'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunk_text).toBe('S\nfirst para  \nsecond para')
  })

  it('drops non-printable characters from lines', () => {
    // NUL is not JS whitespace, so trim leaves it and the port's
    // printable filter must delete it.
    const chunks = chunkOne('nul.md', ['## S', '', 'text\u0000with nul'])
    expect(chunks[0]?.chunk_text).toBe('S\ntextwith nul')
  })

  it('handles CRLF input including front matter', () => {
    const chunks = chunkMarkdown({
      source_path: 'crlf.md',
      text: '---\r\nx: 1\r\n---\r\n# A\r\nbody\r\n',
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunk_text).toBe('A\nbody')
  })

  it('emits one chunk for a headerless document with no section path', () => {
    const chunks = chunkOne('plain.md', ['plain text', '', 'more'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.section_header).toBe('')
    expect(chunks[0]?.chunk_text).toBe('plain text  \nmore')
  })

  it('emits nothing for empty input', () => {
    expect(chunkMarkdown({ source_path: 'e.md', text: '' })).toEqual([])
  })
})

describe('chunkMarkdown: front matter and stored text', () => {
  it('strips YAML front matter before splitting', () => {
    const chunks = chunkOne('fm.md', [
      '---',
      'title: Notes',
      'tags: [a, b]',
      '---',
      '# Real',
      'content',
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunk_text).toBe('Real\ncontent')
  })

  it('never sees # inside front matter as a header', () => {
    const chunks = chunkOne('fm2.md', ['---', '# yaml comment', 'x: 1', '---', 'content only'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.section_header).toBe('')
    expect(chunks[0]?.chunk_text).toBe('content only')
  })
})

describe('chunkMarkdown: long-chunk split and ids', () => {
  it('splits an oversized section into numbered parts sharing one header_hash', () => {
    const chunks = chunkMarkdown(
      {
        source_path: 'big.md',
        text: ['# Big', '', 'Alpha one. Beta two.', '', 'Gamma one. Delta two.'].join('\n'),
      },
      { maxTokens: 10 },
    )

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.part)).toEqual([0, 1])
    expect(new Set(chunks.map((chunk) => chunk.header_hash))).toHaveLength(1)
    for (const chunk of chunks) {
      expect(chunk.section_header).toBe('Big')
      expect(chunk.approxTokens).toBeLessThanOrEqual(10)
    }
    expect(chunks[0]?.chunk_text).toBe('Big\nAlpha one. Beta two.')
    expect(chunks[1]?.chunk_text).toBe('Big\nGamma one. Delta two.')
  })

  it('falls from paragraphs to sentences when one paragraph is oversized', () => {
    const chunks = chunkMarkdown(
      { source_path: 's.md', text: ['# Big', '', 'One. Two. Three.'].join('\n') },
      { maxTokens: 3 },
    )
    expect(chunks.map((chunk) => chunk.chunk_text)).toEqual([
      'Big\nOne.',
      'Big\nTwo.',
      'Big\nThree.',
    ])
  })

  it('hard-cuts a run-on sentence no boundary can split', () => {
    // Budget arithmetic: 'Big\n' (4 chars) plus 36 chars is 40 chars, the
    // largest body forceSplit's binary search accepts at maxTokens 10.
    const chunks = chunkMarkdown(
      { source_path: 'run.md', text: ['# Big', '', 'x'.repeat(120)].join('\n') },
      { maxTokens: 10 },
    )
    expect(chunks.map((chunk) => chunk.part)).toEqual([0, 1, 2, 3])
    expect(chunks.map((chunk) => chunk.chunk_text)).toEqual([
      `Big\n${'x'.repeat(36)}`,
      `Big\n${'x'.repeat(36)}`,
      `Big\n${'x'.repeat(36)}`,
      `Big\n${'x'.repeat(12)}`,
    ])
    for (const chunk of chunks) {
      expect(chunk.approxTokens).toBeLessThanOrEqual(10)
    }
  })

  it('emits one whole oversized part when the header path alone exhausts the budget', () => {
    // Documented forceSplit tradeoff: 'Big\n' alone spends maxTokens 1,
    // no prefix fits, so the body is emitted over budget, never dropped.
    const chunks = chunkMarkdown(
      { source_path: 'h.md', text: ['# Big', '', 'hello there'].join('\n') },
      { maxTokens: 1 },
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunk_text).toBe('Big\nhello there')
    expect(chunks[0]?.approxTokens).toBeGreaterThan(1)
  })

  it('keeps (source_path, header_hash, part) tuples unique', () => {
    const chunks = chunkMarkdown(
      {
        source_path: 'u.md',
        text: ['# Sec', '', 'P one. P two.', '', 'Q one. Q two.', '', 'R one. R two.'].join('\n'),
      },
      { maxTokens: 6 },
    )
    const tuples = chunks.map((chunk) =>
      [chunk.source_path, chunk.header_hash, chunk.part].join('\u0000'),
    )
    expect(tuples).toHaveLength(chunks.length)
    expect(new Set(tuples).size).toBe(chunks.length)
  })

  it('hashes section text so repeated header paths get distinct hashes', () => {
    // "## Notes" recurs after a sibling; aggregation keeps the two
    // Notes sections apart, and the text fragment distinguishes them.
    const chunks = chunkOne('dup.md', [
      '## Notes',
      'first note body',
      '',
      '## Other',
      'other body',
      '',
      '## Notes',
      'second note body',
    ])
    expect(chunks.map((chunk) => chunk.section_header)).toEqual(['Notes', 'Other', 'Notes'])
    expect(chunks[0]?.header_hash).not.toBe(chunks[2]?.header_hash)
  })
})

describe('chunkMarkdown: outputs and stability', () => {
  it('reports approxTokens from constants over chunk_text', () => {
    const chunks = chunkOne('tok.md', ['# A', 'some content here'])
    for (const chunk of chunks) {
      expect(chunk.approxTokens).toBe(approxTokens(chunk.chunk_text))
    }
  })

  it('produces identical chunks for identical input across runs', () => {
    const first = chunkOne('stable.md', ['# A', 'body', '', '## B', 'more'])
    const second = chunkOne('stable.md', ['# A', 'body', '', '## B', 'more'])
    expect(second).toEqual(first)
  })

  it('gives distinct header_hash values to distinct sections', () => {
    const chunks = chunkOne('diff.md', ['# A', 'body a', '', '## B', 'body b'])
    expect(chunks[0]?.header_hash).not.toBe(chunks[1]?.header_hash)
  })

  it('matches the 16-char lowercase hex header_hash shape', () => {
    const chunks = chunkOne('shape.md', ['# A', 'body'])
    expect(chunks[0]?.header_hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('splitLongChunk', () => {
  it('returns the chunk untouched when it already fits', () => {
    const [only] = chunkOne('fit.md', ['# A', 'short body'])
    expect(splitLongChunk(only as Chunk, 500)).toEqual([only])
  })

  it('renumbers parts 0..n while preserving section and hash', () => {
    const text = 'Sec\nFirst para here.  \nSecond para here.'
    const base: Chunk = {
      source_path: 'x.md',
      section_header: 'Sec',
      header_hash: 'deadbeefdeadbeef',
      part: 0,
      chunk_text: text,
      approxTokens: approxTokens(text),
    }
    const parts = splitLongChunk(base, 8)
    expect(parts.map((chunk) => chunk.part)).toEqual([0, 1])
    expect(parts.map((chunk) => chunk.chunk_text)).toEqual([
      'Sec\nFirst para here.',
      'Sec\nSecond para here.',
    ])
    for (const part of parts) {
      expect(part.header_hash).toBe('deadbeefdeadbeef')
      expect(part.section_header).toBe('Sec')
    }
  })
})

describe('stripNoise', () => {
  it('keeps markdown headers and code fences in the copy', () => {
    const kept = '# H\n\n```js\ncode\n```\n'
    expect(stripNoise(kept)).toBe(kept)
  })

  it('drops front matter, HTML comments, data URIs, and autolinks', () => {
    const cleaned = stripNoise([
      '---',
      'title: Notes',
      '---',
      '<!-- secret -->',
      '![logo](data:image/png;base64,iVBORw0KGgo=)',
      'bare data:image/png;base64,iVBORw0KGgo= tail',
      'see <https://example.com/x> and <obsidian://open?vault=v>',
    ].join('\n'))

    expect(cleaned).not.toContain('title: Notes')
    expect(cleaned).not.toContain('secret')
    expect(cleaned).not.toContain('base64')
    expect(cleaned).toContain('logo')
    expect(cleaned).toContain('https://example.com/x')
    expect(cleaned).toContain('obsidian://open?vault=v')
    expect(cleaned).not.toContain('<https://')
    expect(cleaned).not.toContain('<obsidian://')
  })

  it('collapses runs of blank lines to one blank line', () => {
    expect(stripNoise('a\n\n\n\nb')).toBe('a\n\nb')
  })
})
