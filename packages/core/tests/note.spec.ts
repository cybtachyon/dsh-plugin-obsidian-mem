import { describe, expect, it } from 'vitest'
import {
  ensureWhyAndHow,
  isArchived,
  MAX_INDEX_DESCRIPTION_CHARS,
  parseNote,
  serializeNote,
  titleToFilename,
  validateMeta,
} from '../src/note.ts'
import type { Note, NoteMeta } from '../src/note.ts'

/**
 * Note format spec for TASK-012: parse tolerance and defaults, stable
 * serialization, the errors-versus-warnings split in validateMeta, filename
 * slugs with collision suffixes, archive detection, and Why:/How-to-apply
 * body warnings.
 */

function baseMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    index_title: 'Typescript: Writing style',
    index_description: 'House TypeScript style rules for this repo',
    type: 'global',
    archive: false,
    created: '2026-11-01',
    updated: '2026-11-02T15:04:05.000Z',
    read_count: 2,
    ...overrides,
  }
}

function frontmatterKeys(text: string): string[] {
  const block = text.split('---\n')[1] ?? ''
  return block
    .split('\n')
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((line) => line !== '')
}

describe('parseNote', () => {
  it('reads a full note verbatim', () => {
    const note = parseNote([
      '---',
      "index_title: 'Typescript: Writing style'",
      'index_description: House TypeScript style rules for this repo',
      'type: global',
      'archive: false',
      "created: '2026-11-01'",
      "updated: '2026-11-02T15:04:05.000Z'",
      "last_read_at: '2026-11-10'",
      'read_count: 2',
      '---',
      '# Writing style',
      '',
      'Why: shared rules stop re-litigating diffs.',
      '',
    ].join('\n'))

    expect(note.meta).toEqual({
      ...baseMeta(),
      last_read_at: '2026-11-10',
    })
    expect(note.body).toContain('Why: shared rules')
  })

  it('applies defaults for missing fields', () => {
    const note = parseNote('---\ntype: domain\n---\nBody only.\n')

    expect(note.meta).toEqual({
      index_title: '',
      index_description: '',
      type: 'domain',
      archive: false,
      created: '',
      updated: '',
      read_count: 0,
    })
  })

  it('treats a note without frontmatter as all-defaults', () => {
    const note = parseNote('# Just a document\n')

    expect(note.meta.type).toBe('global')
    expect(note.meta.read_count).toBe(0)
    expect(note.meta.archive).toBe(false)
    expect(note.body).toBe('# Just a document\n')
  })

  it('normalizes CRLF input to LF', () => {
    const note = parseNote('---\r\nindex_title: T\r\n---\r\nline one\r\nline two\r\n')

    expect(note.meta.index_title).toBe('T')
    expect(note.body).not.toContain('\r')
  })

  it('coerces YAML date objects back to ISO text', () => {
    // js-yaml parses unquoted datetimes into Date instances.
    const note = parseNote([
      '---',
      'created: 2026-11-12',
      'updated: 2026-11-12T09:30:00Z',
      '---',
      'b',
      '',
    ].join('\n'))

    expect(note.meta.created).toBe('2026-11-12')
    expect(note.meta.updated).toBe('2026-11-12T09:30:00.000Z')
  })

  it('coerces hostile scalars to safe defaults', () => {
    const note = parseNote([
      '---',
      'index_title: 42',
      "archive: 'no'",
      "read_count: '-5'",
      'type: [not, a, slug]',
      '---',
      'body',
      '',
    ].join('\n'))

    expect(note.meta.index_title).toBe('')
    expect(note.meta.archive).toBe(false)
    expect(note.meta.read_count).toBe(0)
    expect(note.meta.type).toBe('global')
  })
})

describe('serializeNote', () => {
  it('writes frontmatter keys in the stable canonical order', () => {
    const text = serializeNote({
      meta: { ...baseMeta(), last_read_at: '2026-11-10' },
      body: '# Writing style\n',
    })

    expect(frontmatterKeys(text)).toEqual([
      'index_title', 'index_description', 'type', 'archive',
      'created', 'updated', 'last_read_at', 'read_count',
    ])
  })

  it('omits optional timestamps that are empty', () => {
    const text = serializeNote({
      meta: { ...baseMeta(), created: '', updated: '' },
      body: '# Writing style\n',
    })

    expect(frontmatterKeys(text)).toEqual([
      'index_title', 'index_description', 'type', 'archive', 'read_count',
    ])
  })

  it('normalizes CRLF bodies and ends them with one newline', () => {
    const text = serializeNote({ meta: baseMeta(), body: 'a\r\nb\r\n\r\n' })

    expect(text).toContain('a\nb\n')
    expect(text.endsWith('\n\n')).toBe(false)
  })

  it('round-trips a note without drift', () => {
    const note: Note = {
      meta: { ...baseMeta(), last_read_at: '2026-11-10' },
      body: '# Writing style\n\nWhy: consistency.\n\nHow to apply: read it.\n',
    }

    const once = serializeNote(note)
    expect(serializeNote(parseNote(once))).toBe(once)
    expect(parseNote(once).meta).toEqual(note.meta)
    expect(parseNote(once).body).toBe(note.body)
  })
})

describe('validateMeta', () => {
  it('accepts a well-formed meta with no findings', () => {
    expect(validateMeta({ ...baseMeta(), last_read_at: '2026-11-10' }))
      .toEqual({ errors: [], warnings: [] })
  })

  it('requires title, description, and type', () => {
    const { errors } = validateMeta({})

    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toMatch(/index_title/)
    expect(errors.join('\n')).toMatch(/index_description/)
    expect(errors.join('\n')).toMatch(/type/)
  })

  it('errors when the description merely repeats the title', () => {
    const { errors, warnings } = validateMeta(baseMeta({
      index_description: 'typescript: writing style.',
    }))

    expect(errors.some((e) => e.includes('repeat index_title'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('warns when the description only embeds the title', () => {
    const { errors, warnings } = validateMeta(baseMeta({
      index_description: 'Typescript: writing style rules for tests too',
    }))

    expect(errors).toEqual([])
    expect(warnings.some((w) => w.includes('repeats its index_title'))).toBe(true)
  })

  it('warns past the soft description length ceiling', () => {
    const long = 'x'.repeat(MAX_INDEX_DESCRIPTION_CHARS + 1)
    const { errors, warnings } = validateMeta(baseMeta({ index_description: long }))

    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(String(MAX_INDEX_DESCRIPTION_CHARS))
  })

  it('accepts scope constants and slugs, rejects other types', () => {
    expect(validateMeta(baseMeta({ type: 'reference' })).errors).toEqual([])
    expect(validateMeta(baseMeta({ type: 'dsh-harness' })).errors).toEqual([])
    expect(validateMeta(baseMeta({ type: 'My_Project' })).errors).toHaveLength(1)
  })

  it('rejects malformed read stats and timestamps', () => {
    const { errors } = validateMeta({
      ...baseMeta({ read_count: -1, created: '2026-02-30' }),
      last_read_at: 'yesterday',
    })
    const text = errors.join('\n')

    expect(text).toMatch(/read_count/)
    expect(text).toMatch(/created/)
    expect(text).toMatch(/last_read_at/)
  })

  it('rejects non-integer read counts and non-boolean archive flags', () => {
    expect(validateMeta(baseMeta({ read_count: 1.5 })).errors.join())
      .toMatch(/read_count/)
    expect(validateMeta({ ...baseMeta(), archive: 'yes' as unknown as boolean }).errors.join())
      .toMatch(/archive/)
  })
})

describe('titleToFilename', () => {
  it('slugifies a topic-scenario title', () => {
    expect(titleToFilename('Typescript: Writing style'))
      .toBe('typescript-writing-style.md')
  })

  it('appends collision suffixes past taken names', () => {
    const taken = ['typescript-writing-style.md', 'typescript-writing-style-2.md']

    expect(titleToFilename('Typescript: Writing style', taken))
      .toBe('typescript-writing-style-3.md')
  })

  it('folds accents and stray punctuation', () => {
    expect(titleToFilename('Café Müller!!')).toBe('cafe-muller.md')
    expect(titleToFilename('  -- leading and trailing -- '))
      .toBe('leading-and-trailing.md')
  })

  it('falls back to untitled for empty slugs', () => {
    expect(titleToFilename('?!?!')).toBe('untitled.md')
    expect(titleToFilename('')).toBe('untitled.md')
  })
})

describe('isArchived', () => {
  it('reads the flag from a note or bare meta', () => {
    expect(isArchived({ meta: baseMeta({ archive: true }), body: '' })).toBe(true)
    expect(isArchived(baseMeta())).toBe(false)
    expect(isArchived(baseMeta({ archive: true }))).toBe(true)
  })
})

describe('ensureWhyAndHow', () => {
  const why = 'Why: this kept the recall budget.'
  const how = 'How to apply: prefer slugs over ids.'

  it('accepts bold discipline lines', () => {
    expect(ensureWhyAndHow(`**${why}**\n**${how}:** always\n`)).toEqual([])
  })

  it('accepts plain, bulleted, and full-width-colon forms', () => {
    expect(ensureWhyAndHow(`${why}\n${how}\n`)).toEqual([])
    expect(ensureWhyAndHow(`- ${why}\n- ${how}\n`)).toEqual([])
    expect(ensureWhyAndHow(`Why： x\nHow to apply： y\n`)).toEqual([])
  })

  it('warns once per missing line', () => {
    const warnings = ensureWhyAndHow(`${why}\n`)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/How to apply/)
    expect(ensureWhyAndHow('nothing here')).toHaveLength(2)
  })

  it('does not count a bare heading as the discipline line', () => {
    expect(ensureWhyAndHow('## Why\n\nno colon form here\n')).toHaveLength(2)
  })
})
