/**
 * Splits vault Markdown into retrieval chunks: a TypeScript port of
 * langchain's MarkdownHeaderTextSplitter (port spec:
 * docs/research/milvus-transformers-findings.md §7), the secondary
 * long-chunk split at paragraph then sentence boundaries, and the
 * noise stripper that cleans a copy of the text at embed time.
 *
 * Stored chunk_text keeps markdown headers (as the prepended
 * section_header path) and code fences; only the embed-time copy loses
 * noise. YAML front matter is stripped before the splitter runs because
 * the ported state machine gives `---` and in-front-matter `#` no
 * special treatment. Pure: no fs, no env, no @deepseek-ai imports.
 * @module dsh-plugin-obsidian-mem/core/chunk
 */

import { approxTokens, CHUNK_MAX_TOKENS } from './constants.js'
import { headerHash } from './idhash.js'

/** One retrieval chunk; field names mirror the Milvus columns. */
export interface Chunk {
  /** Vault-relative file the chunk came from. */
  source_path: string
  /** Header path joined with " > ", e.g. "A > B > C"; '' above any header. */
  section_header: string
  /** 16-hex hash of the header path plus a normalized text fragment. */
  header_hash: string
  /** Index within one section; keeps ids unique per (source_path, header_hash, part). */
  part: number
  /** section_header line (when present) plus the section body. */
  chunk_text: string
  /** approxTokens of chunk_text, from constants. */
  approxTokens: number
}

/** A header level fed to the splitter: its token and metadata key. */
export interface HeaderSpec {
  /** Leading token, e.g. "##". */
  token: string
  /** Metadata key the header populates, e.g. "H2". */
  name: string
}

/** The file to chunk: a vault-relative path plus its Markdown text. */
export interface ChunkInput {
  source_path: string
  text: string
}

/** Knobs for one chunkMarkdown call. */
export interface ChunkOptions {
  /** Levels to split on; defaults to all six ATX levels H1..H6. */
  headers?: readonly HeaderSpec[]
  /** Token ceiling per chunk before the secondary split. */
  maxTokens?: number
}

const DEFAULT_HEADERS: readonly HeaderSpec[] = [
  { token: '#', name: 'H1' },
  { token: '##', name: 'H2' },
  { token: '###', name: 'H3' },
  { token: '####', name: 'H4' },
  { token: '#####', name: 'H5' },
  { token: '######', name: 'H6' },
]

// Two spaces + newline: the markdown hard break langchain joins
// same-metadata runs with; the original blank line is lost by design.
const HARD_BREAK = '  \n'

// Long-chunk split boundaries. Paragraphs break on blank lines or the
// HARD_BREAK join (state machine lines are trimmed, so trailing "  "
// before "\n" is always a join, never original spacing); sentences
// break on whitespace after a terminal .!?.
const PARAGRAPH_BOUNDARY = / {2}\n|\n[ \t]*\n/
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/

// Normalized section text folded into header_hash so two sections that
// share a header path (a repeated "## Notes" heading) still get distinct
// ids. 200 chars distinguishes real content drift without hashing whole
// sections.
const HEADER_FRAGMENT_CHARS = 200

// Python str.isprintable parity for the splitter's per-line cleanup:
// drop Other (Cc/Cf/Cs/Co/Cn) plus the Zl/Zp separators, keep every Zs
// space. Deleting \r silently absorbs \r\n input. The port spec flags
// exact Unicode-category parity as unproven; this rule matches its
// "drop non-printable, keep spaces" instruction.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/gu

// gray-matter's trigger: the file begins with a `---` line and a closing
// `---` line follows. Chunking uses a regex, not gray-matter, so one
// malformed YAML block cannot throw away an otherwise chunkable file;
// note.ts owns YAML semantics.
const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

// Removes a leading YAML front matter block, if present. Regex-based on
// purpose (see FRONT_MATTER above); gray-matter would throw on one
// malformed block and lose the whole file.
function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, '')
}

/**
 * chunkMarkdown splits one Markdown file into retrieval chunks. Front
 * matter is stripped first (the ported splitter gives it no special
 * treatment), sections are aggregated, and any section over maxTokens
 * goes through splitLongChunk. Each chunk's stored text opens with its
 * "A > B > C" header path so embeddings keep the section context.
 */
export function chunkMarkdown(
  input: ChunkInput,
  options: ChunkOptions = {},
): Chunk[] {
  const specs = sortHeaderSpecs(options.headers ?? DEFAULT_HEADERS)
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS

  const entries = splitEntries(stripFrontMatter(input.text), specs)
  const chunks: Chunk[] = []
  for (const entry of aggregateEntries(entries)) {
    const headerPath = joinHeaderPath(entry.metadata, specs)
    const chunk = buildChunk(input.source_path, entry.content, headerPath)
    chunks.push(...splitLongChunk(chunk, maxTokens))
  }
  return chunks
}

// The context every long-chunk fit check consults: the header line each
// part re-carries, plus the per-part token ceiling it must share with it.
interface PartBudget {
  prefix: string
  maxTokens: number
}

/**
 * splitLongChunk splits one oversized chunk at paragraph boundaries
 * first, then sentence boundaries, then hard character cuts, packing
 * the pieces greedily so every part's approxTokens stays within
 * maxTokens unless the header path alone exceeds it. Parts are renumbered
 * 0..n so chunk ids stay unique per (source_path, header_hash, part).
 */
export function splitLongChunk(chunk: Chunk, maxTokens: number = CHUNK_MAX_TOKENS): Chunk[] {
  if (chunk.approxTokens <= maxTokens) {
    return [chunk]
  }

  const prefix = headerPrefix(chunk.section_header)
  const budget: PartBudget = { prefix, maxTokens }
  const body = chunk.chunk_text.slice(prefix.length)

  const atoms: string[] = []
  for (const paragraph of splitUnits(body, PARAGRAPH_BOUNDARY)) {
    if (fitsWithinBudget(paragraph, budget)) {
      atoms.push(paragraph)
      continue
    }
    for (const sentence of splitUnits(paragraph, SENTENCE_BOUNDARY)) {
      if (fitsWithinBudget(sentence, budget)) {
        atoms.push(sentence)
      } else {
        atoms.push(...forceSplit(sentence, budget))
      }
    }
  }

  const bodies: string[] = []
  let current = ''
  for (const atom of atoms) {
    if (current !== '' && fitsWithinBudget(current + HARD_BREAK + atom, budget)) {
      current += HARD_BREAK + atom
    } else {
      if (current !== '') {
        bodies.push(current)
      }
      current = atom
    }
  }
  if (current !== '') {
    bodies.push(current)
  }

  return bodies.map((partBody, index) => finalizeChunk(chunk, index, partBody))
}

/**
 * stripNoise removes retrieval noise from text destined for embedding:
 * YAML front matter, HTML comments, image data/base64 URIs (bare and in
 * link syntax), angle-bracket autolinks, and repeated blank lines. Apply
 * it to a copy of chunk_text; the stored chunk keeps headers and fences.
 */
export function stripNoise(text: string): string {
  return stripFrontMatter(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Keep the alt/link label, drop the data: target.
    .replace(/!?\[([^\]]*)\]\(\s*data:[^)]*\)/g, '$1')
    .replace(/data:[^\s)]*;base64,[A-Za-z0-9+/=]+/gi, '')
    .replace(/<((?:https?|ftp|file|mailto|obsidian):[^\s<>]*)>/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
}

// The ported split_text state machine (§7.2). Specs arrive pre-sorted by
// token length descending; strip_headers is fixed true (headers live in
// metadata and the prepended path, never in the body) and the
// custom_header_patterns extension is not ported.
interface SplitterHeader {
  level: number
  name: string
  data: string
}

interface Entry {
  content: string
  metadata: Record<string, string>
}

function splitEntries(text: string, specs: readonly HeaderSpec[]): Entry[] {
  const entries: Entry[] = []
  let currentContent: string[] = []
  let currentMetadata: Record<string, string> = {}
  const headerStack: SplitterHeader[] = []
  const initialMetadata: Record<string, string> = {}
  let inCodeBlock = false
  let openingFence = ''

  const flush = (): void => {
    if (currentContent.length > 0) {
      entries.push({ content: currentContent.join('\n'), metadata: { ...currentMetadata } })
      currentContent = []
    }
  }

  for (const rawLine of text.split('\n')) {
    const stripped = rawLine.trim().replace(NON_PRINTABLE, '')

    // Fence tracking runs before header matching: a `#` inside a fence
    // is never a header. count("```") === 1 means a single line holding
    // both fences (```js … ```) does not open a block.
    if (!inCodeBlock) {
      if (stripped.startsWith('```') && countOccurrences(stripped, '```') === 1) {
        inCodeBlock = true
        openingFence = '```'
      } else if (stripped.startsWith('~~~')) {
        inCodeBlock = true
        openingFence = '~~~'
      }
    } else if (stripped.startsWith(openingFence)) {
      inCodeBlock = false
      openingFence = ''
    }

    if (inCodeBlock) {
      currentContent.push(stripped)
      continue
    }

    const header = specs.find(({ token }) => isHeaderLine(stripped, token))
    if (header !== undefined) {
      const level = countOccurrences(header.token, '#')
      // Pop siblings and deeper headers, retiring their metadata keys;
      // ancestors survive.
      let top = headerStack.at(-1)
      while (top !== undefined && top.level >= level) {
        headerStack.pop()
        delete initialMetadata[top.name]
        top = headerStack.at(-1)
      }
      const headerData = stripped.slice(header.token.length).trim()
      headerStack.push({ level, name: header.name, data: headerData })
      initialMetadata[header.name] = headerData
      // flush() reads currentMetadata: the snapshot taken before this
      // header mutated initialMetadata, so pre-header content keeps its
      // own section.
      flush()
    } else if (stripped !== '') {
      currentContent.push(stripped)
    } else if (currentContent.length > 0) {
      // A blank line terminates the current entry; a blank line with an
      // empty buffer emits nothing.
      flush()
    }

    currentMetadata = { ...initialMetadata }
  }

  flush()
  return entries
}

// Same-metadata runs join with the hard break. LangChain's second branch
// (adopt a deeper metadata when the last line is a bare "#") applies
// only with strip_headers false, which this port fixes to true, so the
// branch is intentionally absent.
function aggregateEntries(entries: readonly Entry[]): Entry[] {
  const aggregated: Entry[] = []
  for (const entry of entries) {
    const last = aggregated.at(-1)
    if (last !== undefined && metadataEqual(last.metadata, entry.metadata)) {
      last.content += HARD_BREAK + entry.content
      continue
    }
    aggregated.push({ content: entry.content, metadata: entry.metadata })
  }
  return aggregated
}

// Sorting by token length DESC is load-bearing: "###" must be tested
// before "##" before "#", or "### x" would match the "#" spec.
function sortHeaderSpecs(specs: readonly HeaderSpec[]): HeaderSpec[] {
  return [...specs].sort((a, b) => b.token.length - a.token.length)
}

// Python dict equality for the aggregation check: same key set, same
// values, insertion order irrelevant.
function metadataEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  return keys.every((key) => a[key] === b[key])
}

function joinHeaderPath(
  metadata: Record<string, string>,
  specs: readonly HeaderSpec[],
): string {
  // specs are sorted token length DESC; reversing walks level ASC.
  return [...specs]
    .reverse()
    .map(({ name }) => metadata[name] ?? '')
    .filter((data) => data !== '')
    .join(' > ')
}

function buildChunk(
  sourcePath: string,
  content: string,
  headerPath: string,
): Chunk {
  const fragment = content.replace(/\s+/g, ' ').trim().slice(0, HEADER_FRAGMENT_CHARS)
  const hash = headerHash(`${headerPath}\n${fragment}`)
  return finalizeChunk(
    { source_path: sourcePath, section_header: headerPath, header_hash: hash },
    0,
    content,
  )
}

// The section fields every part of one section re-carries; Chunk itself
// satisfies it, so splitLongChunk hands the whole chunk as the base.
interface PartBase {
  source_path: string
  section_header: string
  header_hash: string
}

function finalizeChunk(base: PartBase, part: number, body: string): Chunk {
  const chunkText = `${headerPrefix(base.section_header)}${body}`
  return {
    source_path: base.source_path,
    section_header: base.section_header,
    header_hash: base.header_hash,
    part,
    chunk_text: chunkText,
    approxTokens: approxTokens(chunkText),
  }
}

function headerPrefix(headerPath: string): string {
  return headerPath === '' ? '' : `${headerPath}\n`
}

// ATX header shape: the token plus end-of-line or a space. "#Title" with
// no space is content; a bare "#" is a header with empty text.
function isHeaderLine(stripped: string, token: string): boolean {
  return stripped.startsWith(token)
    && (stripped.length === token.length || stripped[token.length] === ' ')
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// Split on a boundary pattern and drop the empty or whitespace-only
// units a split always leaves behind.
function splitUnits(text: string, boundary: RegExp): string[] {
  return text.split(boundary).map((unit) => unit.trim()).filter((unit) => unit !== '')
}

function fitsWithinBudget(body: string, budget: PartBudget): boolean {
  return approxTokens(budget.prefix + body) <= budget.maxTokens
}

// Hard cut at the largest prefix that still fits. Binary search keeps
// approxTokens the single definition of the budget; a slice that cannot
// fit at all (the header path alone exhausts maxTokens) emits whole to
// avoid an infinite loop, documented tradeoff.
function forceSplit(unit: string, budget: PartBudget): string[] {
  const pieces: string[] = []
  let rest = unit
  while (rest !== '') {
    const cut = maxPrefixWithinBudget(rest, (length) => (
      approxTokens(budget.prefix + rest.slice(0, length)) <= budget.maxTokens
    ))
    if (cut === 0) {
      pieces.push(rest)
      break
    }
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return pieces
}

function maxPrefixWithinBudget(text: string, fits: (length: number) => boolean): number {
  if (!fits(0)) {
    return 0
  }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}
