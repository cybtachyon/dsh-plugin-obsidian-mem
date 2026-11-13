/**
 * memory_write behavior spec over a real temp vault tree plus a fake
 * seam: the guard ladder (shared-markdown target, reserved files,
 * read-before-write staleness with the on-disk content-hash re-check, the
 * brand-new path exemption, read-only refusal), core validateMeta as a
 * refusal value with discipline warnings on success, title-slugged naming
 * with collision suffixes for new notes, and the frontmatter round-trip
 * of what actually lands on disk.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { contentHash, parseNote, serializeNote } from '../../core/lib/index.js'
import { createWriteTool, executeWrite, renderWrite } from '../src/index.ts'
import type { WriteValue } from '../src/index.ts'
import { createFakeService, makeTempTree, matchesOutput, vaultEntries } from './testkit.ts'
import type { FakeMemoryService } from './testkit.ts'

const NOTICE = 'Default vault ready at /home/tester/.dsh/obsidian-mem.'

const existingText = serializeNote({
  meta: {
    index_title: 'Deploys: Legacy host',
    index_description: 'Old API host before the move.',
    type: 'global',
    archive: true,
    created: '2026-01-05',
    updated: '2026-01-05',
    last_read_at: '2026-02-01',
    read_count: 7,
  },
  body: '# Legacy host\n\n**Why:** history.\n**How to apply:** cite it.',
})

function localToday(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

let tree: { root: string, cleanup: () => void }
let sharedRoot: string
let readOnlyRoot: string
let existingPath: string
let service: FakeMemoryService

beforeEach(() => {
  tree = makeTempTree({
    'vaults/shared/markdown/legacy-host.md': existingText,
    'vaults/ro/markdown/quiet.md': existingText,
  })
  sharedRoot = join(tree.root, 'vaults', 'shared')
  readOnlyRoot = join(tree.root, 'vaults', 'ro')
  existingPath = join(sharedRoot, 'markdown', 'legacy-host.md')
  service = createFakeService({
    vaults: vaultEntries(
      { path: sharedRoot, mode: 'shared' },
      { path: readOnlyRoot, mode: 'read-only' },
    ),
    notice: NOTICE,
  })
})

afterEach(() => {
  tree.cleanup()
})

/** Seed the read registry with the CURRENT bytes, as memory_read would. */
function seedReadRecord(path: string): void {
  service.records.set(path, {
    contentHash: contentHash(readFileSync(path, 'utf8')),
    mtimeMs: 0,
    at: Date.now(),
  })
}

function write(args: Record<string, unknown>): Promise<WriteValue> {
  return executeWrite(service, {
    index_title: 'Deploys: Friday releases',
    index_description: 'Open before any Friday deploy: the two checks that caught the last incident.',
    type: 'global',
    contents: 'Steps.\n\nWhy: last incident.\nHow to apply: run both checks.',
    ...args,
  }) as Promise<WriteValue>
}

function onDisk(path: string): ReturnType<typeof parseNote> {
  return parseNote(readFileSync(path, 'utf8'))
}

describe('memory_write guards', () => {
  it('refuses paths outside the note tree, listing shared vault roots', async () => {
    const outside = await write({ path: join(tree.root, 'notes', 'a.md') })
    expect(outside.kind).toBe('outside_markdown')
    if (outside.kind !== 'outside_markdown') return
    expect(outside.shared_note_dirs).toEqual([sharedRoot])
    expect(matchesOutput(createWriteTool(service), outside)).toEqual([])

    // TASK-008 adaptation: root .md files ARE notes now; the refused
    // in-vault shape is plugin-internal.
    const inPluginDir = await write({ path: join(sharedRoot, '.obsidian-mem', 'stray.md') })
    expect(inPluginDir.kind).toBe('outside_markdown')
    if (inPluginDir.kind === 'outside_markdown') {
      expect(inPluginDir.message).toContain('outside its note tree')
    }
  })

  it('refuses read-only vault targets by name', async () => {
    const value = await write({ path: join(readOnlyRoot, 'markdown', 'new-note.md') })
    expect(value.kind).toBe('read_only_vault')
    if (value.kind !== 'read_only_vault') return
    expect(value.vault).toBe(readOnlyRoot)
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])
    expect(service.writeRequests).toEqual([])
  })

  it('refuses reserved protocol files anywhere in the tree', async () => {
    // TASK-008 adaptation: with root notes, reserved names are outside the
    // note tree everywhere, so the note-tree guard answers first; the
    // reserved_file ladder moves with that task's guard reshuffle.
    const dreams = await write({ path: join(sharedRoot, 'markdown', 'DREAMS.md') })
    expect(dreams.kind).toBe('outside_markdown')
    const history = await write({ path: join(sharedRoot, 'markdown', 'topic_history.md') })
    expect(history.kind).toBe('outside_markdown')
    expect(service.writeRequests).toEqual([])
  })

  it('refuses to overwrite a file this session never read', async () => {
    const value = await write({ path: existingPath })
    expect(value.kind).toBe('read_required')
    if (value.kind !== 'read_required') return
    expect(value.message).toContain('memory_read')
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])
    expect(service.writeRequests).toEqual([])
  })

  it('refuses when the bytes changed since the recorded read', async () => {
    seedReadRecord(existingPath)
    // A human edits the note after the model's memory_read.
    appendFileSync(existingPath, '\nHuman edit.\n')

    const value = await write({ path: existingPath, contents: 'Overwrite.' })
    expect(value.kind).toBe('stale')
    if (value.kind !== 'stale') return
    expect(value.message).toContain('changed on disk')
    expect(value.message).toContain('memory_read')
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])
    expect(service.writeRequests).toEqual([])
  })

  it('exempts brand-new paths from read-before-write', async () => {
    const value = await write({ path: join(sharedRoot, 'markdown', 'fresh', 'whatever.md') })
    expect(value.kind).toBe('written')
    expect(service.writeRequests).toHaveLength(1)
  })

  it('refuses frontmatter contract violations with core validateMeta errors', async () => {
    const value = await write({
      path: join(sharedRoot, 'markdown', 'a.md'),
      index_title: 'Same text',
      index_description: 'Same text',
      type: 'Not A Slug!',
    })
    expect(value.kind).toBe('invalid_meta')
    if (value.kind !== 'invalid_meta') return
    expect(value.errors.join('\n')).toContain('index_description')
    expect(value.errors.join('\n')).toContain('type')
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])
    expect(service.writeRequests).toEqual([])
  })
})

describe('memory_write success paths', () => {
  it('names a new note from its title and returns the final path', async () => {
    const value = await write({ path: join(sharedRoot, 'markdown', 'draft-scratch.md') })
    expect(value.kind).toBe('written')
    if (value.kind !== 'written') return
    expect(value.path).toBe(join(sharedRoot, 'markdown', 'deploys-friday-releases.md'))
    expect(value.created).toBe(true)
    expect(value.vault).toBe(sharedRoot)
    expect(value.write_through).toBe('attempted')
    expect(value.warnings).toEqual([])
    expect(value.notice).toBe(NOTICE)
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])

    const note = onDisk(value.path)
    expect(note.meta.index_title).toBe('Deploys: Friday releases')
    expect(note.meta.type).toBe('global')
    expect(note.meta.archive).toBe(false)
    expect(note.meta.created).toBe(localToday())
    expect(note.meta.updated).toBe(localToday())
    expect(note.meta.read_count).toBe(0)
    expect(note.body).toContain('How to apply:')
  })

  it('treats a directory target as a new note slugged INTO that directory', async () => {
    // The documented new-note contract: path may be the markdown/ dir
    // itself. The dir exists on disk yet must not trip read-before-write.
    const value = await write({ path: join(sharedRoot, 'markdown') + '/' })
    expect(value.kind).toBe('written')
    if (value.kind !== 'written') return
    expect(value.path).toBe(join(sharedRoot, 'markdown', 'deploys-friday-releases.md'))
    expect(value.created).toBe(true)
    expect(matchesOutput(createWriteTool(service), value)).toEqual([])
  })

  it('collision-suffixes a new note whose slug is already taken', async () => {
    // The slug exists as a different note; the write must not clobber it.
    const takenPath = join(sharedRoot, 'markdown', 'deploys-friday-releases.md')
    writeFileSync(takenPath, '# occupied\n')

    const value = await write({ path: join(sharedRoot, 'markdown', 'untitled.md') })
    expect(value.kind).toBe('written')
    if (value.kind !== 'written') return
    expect(value.path).toBe(join(sharedRoot, 'markdown', 'deploys-friday-releases-2.md'))
    expect(onDisk(takenPath).body).toContain('occupied')
  })

  it('updates a read note in place, preserving created/archive/stats', async () => {
    seedReadRecord(existingPath)
    const value = await write({
      path: existingPath,
      index_title: 'Deploys: Legacy host',
      index_description: 'Old API host before the move.',
      type: 'global',
      contents: '# Legacy host\n\n**Why:** history kept.\n**How to apply:** cite it.\n',
    })
    expect(value.kind).toBe('written')
    if (value.kind !== 'written') return
    expect(value.path).toBe(existingPath)
    expect(value.created).toBe(false)
    expect(value.warnings).toEqual([])

    const note = onDisk(existingPath)
    expect(note.meta.created).toBe('2026-01-05')
    expect(note.meta.updated).toBe(localToday())
    expect(note.meta.archive).toBe(true)
    expect(note.meta.read_count).toBe(7)
    expect(note.meta.last_read_at).toBe('2026-02-01')
    expect(note.body).toContain('history kept')
  })

  it('lets an explicit archive flag override the stored state', async () => {
    seedReadRecord(existingPath)
    const value = await write({
      path: existingPath,
      index_title: 'Deploys: Legacy host',
      index_description: 'Old API host before the move.',
      type: 'global',
      archive: false,
      contents: '# Legacy host\n\nWhy: revived.\nHow to apply: use again.\n',
    })
    expect(value.kind).toBe('written')
    expect(onDisk(existingPath).meta.archive).toBe(false)
  })

  it('returns discipline warnings without rejecting the note', async () => {
    const value = await write({
      path: join(sharedRoot, 'markdown', 'loose.md'),
      index_title: 'Deploys: Friday releases',
      index_description: 'Deploys: Friday releases notes collected over time about checklists and steps.',
      contents: 'Just some loose prose with no discipline lines.',
    })
    expect(value.kind).toBe('written')
    if (value.kind !== 'written') return
    expect(value.warnings.join('\n')).toContain('index_description')
    expect(value.warnings.join('\n')).toContain('Why')
    expect(value.warnings.join('\n')).toContain('How to apply')
  })
})

describe('memory_write rendering', () => {
  it('renders the written line plus warnings', async () => {
    const value = await write({
      path: join(sharedRoot, 'markdown', 'loose.md'),
      index_title: 'Deploys: Friday releases',
      index_description: 'Deploys: Friday releases collected over the whole quarter for checklists.',
      contents: 'Loose prose.',
    })
    const text = renderTool(value)
    expect(text).toContain('Created memory note:')
    expect(text).toContain('deploys-friday-releases.md')
    expect(text).toContain('Warnings:')
  })

  it('renders refusals from their messages and errors', async () => {
    const staleText = renderTool({
      kind: 'stale',
      path: '/v/markdown/a.md',
      message: '/v/markdown/a.md changed on disk after your last memory_read.',
    })
    expect(staleText).toContain('changed on disk')

    const invalidText = renderTool({
      kind: 'invalid_meta',
      path: '/v/markdown/a.md',
      errors: ['index_title is required'],
    })
    expect(invalidText).toContain('the frontmatter needs fixing')
    expect(invalidText).toContain('- index_title is required')
  })

  it('prepends the provisioning notice once', async () => {
    const first = await write({ path: join(sharedRoot, 'markdown', 'a.md') })
    expect(renderTool(first).startsWith(`${NOTICE}\n\n`)).toBe(true)
    const second = await write({ path: join(sharedRoot, 'markdown', 'b.md') })
    expect(renderTool(second).includes(NOTICE)).toBe(false)
  })

  function renderTool(value: WriteValue): string {
    return renderWrite(value)
  }
})
