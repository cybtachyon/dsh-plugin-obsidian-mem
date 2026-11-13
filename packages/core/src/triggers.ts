/**
 * Deterministic trigger extraction: the wake_keywords,
 * trigger_extensions, and trigger_frameworks every indexed chunk carries.
 * Heuristics only, exactly the Q3 decision ("heuristics always + optional
 * LLM upgrade"); the LLM pass lives in the service indexer and merges
 * onto these results.
 *
 * Pure text analysis over one chunk plus its note frontmatter and the
 * workspace-manifest vocabulary: no fs, no env, no @deepseek-ai imports.
 * Lists are deduplicated, lowercased, and capped to the collection's
 * MILVUS_ARRAY_CAPACITIES / MILVUS_ARRAY_ELEMENT_MAX_LENGTHS so a
 * returned row can never overflow the Array<VarChar> columns. Field names
 * mirror the Milvus columns, as in chunk.ts.
 * @module dsh-plugin-obsidian-mem/core/triggers
 */

import {
  INTENT_MARKERS,
  MILVUS_ARRAY_CAPACITIES,
  MILVUS_ARRAY_ELEMENT_MAX_LENGTHS,
} from './constants.js'

/** Frontmatter plus chunk context for one extractTriggers call. */
export interface TriggerInput {
  /**
   * Raw note frontmatter (Note.raw from parseNote). Read keys:
   * `trigger_extensions` and `trigger_frameworks` (whole-list overrides)
   * and `keywords` (prepended wake keywords). Absent keys mean pure
   * text heuristics.
   */
  noteMeta?: Record<string, unknown>
  /** The chunk's stored text (chunk_text), header path line included. */
  sectionText: string
  /** Vault-relative source file path; its own name is an extension signal. */
  filePath: string
  /** Framework labels from the workspace manifest; applied only when the section text names them. */
  manifestVocabulary?: TriggerVocabulary
}

/** Workspace-manifest signals the heuristics may consult. */
export interface TriggerVocabulary {
  /** Framework labels (WorkspaceManifest.frameworks and friends). */
  frameworks?: readonly string[]
}

/** The three Array<VarChar> trigger columns, extraction-ready. */
export interface Triggers {
  trigger_extensions: string[]
  trigger_frameworks: string[]
  wake_keywords: string[]
}

// Fenced-block language token to the file extension it signals. A
// deliberate allowlist: unknown fence languages (mermaid, text, console
// transcripts, plain) carry no file-type signal and are dropped rather
// than turned into a fabricated ".mermaid" trigger.
const FENCE_LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'javascript': '.js',
  'js': '.js',
  'mjs': '.mjs',
  'cjs': '.cjs',
  'jsx': '.jsx',
  'typescript': '.ts',
  'ts': '.ts',
  'mts': '.mts',
  'cts': '.cts',
  'tsx': '.tsx',
  'python': '.py',
  'py': '.py',
  'python3': '.py',
  'ruby': '.rb',
  'rb': '.rb',
  'go': '.go',
  'golang': '.go',
  'rust': '.rs',
  'rs': '.rs',
  'java': '.java',
  'kotlin': '.kt',
  'kt': '.kt',
  'scala': '.scala',
  'swift': '.swift',
  'php': '.php',
  'csharp': '.cs',
  'cs': '.cs',
  'c#': '.cs',
  'cpp': '.cpp',
  'c++': '.cpp',
  'c': '.c',
  'h': '.h',
  'bash': '.sh',
  'sh': '.sh',
  'shell': '.sh',
  'zsh': '.sh',
  'powershell': '.ps1',
  'ps1': '.ps1',
  'bat': '.bat',
  'batch': '.bat',
  'sql': '.sql',
  'html': '.html',
  'css': '.css',
  'scss': '.scss',
  'less': '.less',
  'yaml': '.yaml',
  'yml': '.yaml',
  'json': '.json',
  'jsonc': '.json',
  'toml': '.toml',
  'xml': '.xml',
  'ini': '.ini',
  'conf': '.conf',
  'dockerfile': '.dockerfile',
  'docker': '.dockerfile',
  'makefile': '.mk',
  'make': '.mk',
  'cmake': '.cmake',
  'lua': '.lua',
  'r': '.r',
  'perl': '.pl',
  'pl': '.pl',
  'elixir': '.ex',
  'ex': '.ex',
  'exs': '.exs',
  'erlang': '.erl',
  'dart': '.dart',
  'zig': '.zig',
  'haskell': '.hs',
  'julia': '.jl',
  'vue': '.vue',
  'svelte': '.svelte',
  'graphql': '.graphql',
  'proto': '.proto',
  'protobuf': '.proto',
  'terraform': '.tf',
  'tf': '.tf',
  'hcl': '.tf',
  'gradle': '.gradle',
  'groovy': '.groovy',
  'tex': '.tex',
  'latex': '.tex',
}

// Extensions accepted from inline file-path mentions. Broader than the
// fence map (a note can name a file the fence map has no language for)
// and a hard allowlist: "example.com" and "1.2.3" must not become
// triggers, so only known file-type suffixes qualify.
const KNOWN_INLINE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.values(FENCE_LANGUAGE_EXTENSIONS),
  '.md',
  '.txt',
  '.log',
  '.csv',
  '.lock',
  '.env',
  '.ipynb',
  '.htm',
])

// Framework aliases mapped to their canonical lowercase label. Mirrors
// the manifest.ts framework set and adds the data/infra names memory
// notes most often carry. Presence-gated (see collectFrameworks), so a
// common word like "spring" only fires when it actually appears.
const FRAMEWORK_ALIASES: Readonly<Record<string, string>> = {
  'react': 'react',
  'vue': 'vue',
  'angular': 'angular',
  'svelte': 'svelte',
  'solidjs': 'solidjs',
  'next': 'next',
  'nextjs': 'next',
  'nuxt': 'nuxt',
  'express': 'express',
  'nest': 'nest',
  'nestjs': 'nest',
  'vite': 'vite',
  'webpack': 'webpack',
  'vitest': 'vitest',
  'jest': 'jest',
  'django': 'django',
  'flask': 'flask',
  'fastapi': 'fastapi',
  'rails': 'rails',
  'laravel': 'laravel',
  'symfony': 'symfony',
  'doctrine': 'doctrine',
  'spring': 'spring',
  'springboot': 'spring',
  'gin': 'gin',
  'actix': 'actix',
  'tokio': 'tokio',
  'axum': 'axum',
  'milvus': 'milvus',
  'postgres': 'postgres',
  'postgresql': 'postgres',
  'mysql': 'mysql',
  'sqlite': 'sqlite',
  'redis': 'redis',
  'mongodb': 'mongodb',
  'mongo': 'mongodb',
  'kafka': 'kafka',
  'elasticsearch': 'elasticsearch',
  'docker': 'docker',
  'kubernetes': 'kubernetes',
  'k8s': 'kubernetes',
  'terraform': 'terraform',
  'ansible': 'ansible',
  'grpc': 'grpc',
  'graphql': 'graphql',
  'protobuf': 'protobuf',
}

// ``` / ~~~ fence opening with its language token.
const FENCE_OPEN = /(?:^|\n)[ \t]*(?:```|~~~)[ \t]*([A-Za-z][A-Za-z0-9+#.+-]{0,15})[ \t]*$/gm

// `foo.ts`, `notes/server.py`, `vite.config.mts`: a path-ish token ending
// in .<letters+digits>. The trailing lookahead keeps version fragments
// out; the KNOWN_INLINE_EXTENSIONS set does the rest.
const INLINE_PATH = /[\p{L}\p{N}][\p{L}\p{N}_./+-]*\.([A-Za-z][A-Za-z0-9]{0,7})(?![\p{L}\p{N}])/gu

// ATX header lines inside chunk text (fence interiors included; a `#`
// comment inside a fence is a small over-capture the heuristics accept).
const ATX_HEADER = /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+([^\n]+)/g

// Emphasis spans: bold first (** / __), then single * and _ with
// identifier guards so snake_case names and stray stars are not split.
const BOLD_SPAN = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g
const EMPHASIS_SPAN = /(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])/gu

// Punctuation a header or **span** clings to but that carries no
// retrieval meaning; trimmed from both ends of a wake keyword.
const KEYWORD_EDGES = /^[\s"'`([{:;,.!?—-]+|[\s"'`)\]}:;,.!?—-]+$/g

// Wake-keyword shape bounds: 8 words caps runaway sentences, and 64 chars
// is the schema element cap (MILVUS_ARRAY_ELEMENT_MAX_LENGTHS repeats it).
const MAX_WAKE_KEYWORD_WORDS = 8

/**
 * ExtractTriggers computes the three trigger lists for one chunk.
 * Overrides win wholesale: a frontmatter `trigger_extensions:` or
 * `trigger_frameworks:` replaces the heuristics for that field (the
 * author's explicit vocabulary beats detection). `keywords:` only
 * prepends; text signals still contribute wake keywords. Order is
 * deterministic: frontmatter first, then fence/inline/manifest/header/
 * emphasis/marker discovery order, deduplicated, lowercased, capped.
 */
export function extractTriggers(input: TriggerInput): Triggers {
  const meta = input.noteMeta ?? {}
  const text = input.sectionText
  const manifestFrameworks = input.manifestVocabulary?.frameworks ?? []

  return {
    trigger_extensions: extractExtensions(meta, text, input.filePath),
    trigger_frameworks: extractFrameworks(meta, text, manifestFrameworks),
    wake_keywords: extractWakeKeywords(meta, text),
  }
}

// Frontmatter override, else fenced-block languages, inline file paths,
// and the note's own file name (a note titled `server.ts.md` is about a
// .ts file) unioned in discovery order.
function extractExtensions(
  meta: Record<string, unknown>,
  text: string,
  filePath: string,
): string[] {
  const override = frontmatterList(meta['trigger_extensions'])
    .map(normalizeExtension)
    .filter((ext): ext is string => ext !== null)
  if (override.length > 0) {
    return cap(override, MILVUS_ARRAY_CAPACITIES.triggerExtensions,
      MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerExtensions)
  }

  const extensions: string[] = []
  for (const match of text.matchAll(FENCE_OPEN)) {
    const ext = FENCE_LANGUAGE_EXTENSIONS[(match[1] ?? '').toLowerCase()]
    if (ext !== undefined) {
      extensions.push(ext)
    }
  }
  for (const match of text.matchAll(INLINE_PATH)) {
    const ext = `.${(match[1] ?? '').toLowerCase()}`
    if (KNOWN_INLINE_EXTENSIONS.has(ext)) {
      extensions.push(ext)
    }
  }
  const own = normalizeExtension(filePath.replace(/\.md$/i, '').match(/\.([A-Za-z][A-Za-z0-9]{0,7})$/)?.[1] ?? '')
  if (own !== null && KNOWN_INLINE_EXTENSIONS.has(own)) {
    extensions.push(own)
  }
  return cap(dedupe(extensions), MILVUS_ARRAY_CAPACITIES.triggerExtensions,
    MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerExtensions)
}

// Frontmatter override, else every framework alias and manifest label
// that appears as a word in the section text. Manifest labels are
// presence-gated on purpose: the workspace knows about react, but a note
// about vault CSS must not inherit the react trigger.
function extractFrameworks(
  meta: Record<string, unknown>,
  text: string,
  manifestFrameworks: readonly string[],
): string[] {
  const override = frontmatterList(meta['trigger_frameworks'])
    .map((value) => value.toLowerCase())
  if (override.length > 0) {
    return cap(dedupe(override), MILVUS_ARRAY_CAPACITIES.triggerFrameworks,
      MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerFrameworks)
  }

  const candidates = new Set<string>()
  for (const alias of Object.keys(FRAMEWORK_ALIASES)) {
    if (wordPresent(text, alias)) {
      candidates.add(FRAMEWORK_ALIASES[alias] as string)
    }
  }
  for (const label of manifestFrameworks) {
    const canonical = label.trim().toLowerCase()
    if (canonical !== '' && wordPresent(text, canonical)) {
      candidates.add(canonical)
    }
  }
  return cap([...candidates], MILVUS_ARRAY_CAPACITIES.triggerFrameworks,
    MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerFrameworks)
}

// Wake keywords in fixed source order: frontmatter keywords, the chunker's
// "A > B > C" header-path first line, ATX headers, bold and emphasized
// spans, then intent-marker words present in the text.
function extractWakeKeywords(
  meta: Record<string, unknown>,
  text: string,
): string[] {
  const keywords: string[] = frontmatterList(meta['keywords']).map(normalizePhrase)

  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  if (!firstLine.trimStart().startsWith('#') && firstLine.includes(' > ')) {
    keywords.push(...firstLine.split(' > ').map(normalizePhrase))
  }

  for (const match of text.matchAll(ATX_HEADER)) {
    keywords.push(normalizePhrase(match[1] ?? ''))
  }
  for (const match of text.matchAll(BOLD_SPAN)) {
    keywords.push(normalizePhrase(match[1] ?? match[2] ?? ''))
  }
  for (const match of text.matchAll(EMPHASIS_SPAN)) {
    keywords.push(normalizePhrase(match[1] ?? match[2] ?? ''))
  }
  for (const marker of INTENT_MARKERS) {
    if (wordPresent(text, marker)) {
      keywords.push(marker)
    }
  }

  const usable = keywords.filter((keyword) => isUsableKeyword(keyword))
  return cap(dedupe(usable), MILVUS_ARRAY_CAPACITIES.wakeKeywords,
    MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords)
}

// Frontmatter list values arrive as YAML arrays, comma lists, or a single
// scalar; all three normalize to a trimmed string list.
function frontmatterList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item).trim())
      .filter((item) => item !== '')
  }
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== '')
  }
  return []
}

// ".ts", "ts", ".TS ", " .tsx" all normalize to one dotted lowercase
// form; anything left of that is not an extension.
function normalizeExtension(raw: string): string | null {
  const core = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9+#]/g, '')
  return core === '' ? null : `.${core}`
}

// Word-boundary presence test, case-insensitive, with identifier-aware
// boundaries so "kubernetes" does not match inside "kubernetes-cli".
function wordPresent(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

// Keyword canonical form: lowercase, inner whitespace collapsed, edge
// punctuation trimmed (headers arrive as "**Why:**").
function normalizePhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(KEYWORD_EDGES, '')
}

// A wake keyword must be at least 2 chars, at most the schema element
// cap, and few enough words to behave like a keyword, not a sentence.
function isUsableKeyword(keyword: string): boolean {
  if (keyword.length < 2 || keyword.length > MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords) {
    return false
  }
  return keyword.split(' ').length <= MAX_WAKE_KEYWORD_WORDS
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

// Cap the list length and drop over-long elements; the collection's
// max_capacity and max_length are the hard contract (constants.ts).
function cap(values: readonly string[], maxCount: number, maxLength: number): string[] {
  return values.filter((value) => value.length <= maxLength).slice(0, maxCount)
}
