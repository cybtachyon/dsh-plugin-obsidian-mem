/**
 * Codifies the names, layout, budgets, and backend identifiers every layer
 * of the plugin shares: intent markers, scope values, the vault layout,
 * default on-disk locations, the recalled-memory wrappers, tool names,
 * budget defaults, and the Milvus/embedder identifiers.
 *
 * Pure: no fs, no env, no @deepseek-ai imports. $HOME enters only as an
 * explicit homedir argument at call time; the service injects os.homedir()
 * so this module stays deterministic under test.
 * @module dsh-plugin-obsidian-mem/core/constants
 */

import { join } from 'node:path'

/**
 * INTENT_MARKERS lists the nine recall-intent markers in canonical order.
 * .INTENTS.md seeds one section per marker; audit and the wake-keyword pass
 * enumerate this list as the single source of truth.
 */
export const INTENT_MARKERS = [
  'who',
  'what',
  'when',
  'where',
  'how',
  'why',
  'investigate',
  'debug',
  'troubleshoot',
] as const

/** One of the nine .INTENTS.md section markers. */
export type IntentMarker = typeof INTENT_MARKERS[number]

/** Tests whether value names one of the nine intent markers. */
export function isIntentMarker(value: string): value is IntentMarker {
  return (INTENT_MARKERS as readonly string[]).includes(value)
}

/** Scope constant: a memory true across every vault and project. */
export const SCOPE_GLOBAL = 'global'
/** Scope constant: a memory bound to one working domain. */
export const SCOPE_DOMAIN = 'domain'
/** Scope constant: a memory pointing at external reference material. */
export const SCOPE_REFERENCE = 'reference'

/** The three named scope constants; project scope is a slug instead. */
export const SCOPE_TYPES = [SCOPE_GLOBAL, SCOPE_DOMAIN, SCOPE_REFERENCE] as const

/** A named scope or, by isScopeSlug, a project slug. */
export type ScopeType = typeof SCOPE_TYPES[number]

// Kebab-case: lowercase alphanumerics joined by single hyphens. Rejects
// leading/trailing/double hyphens, spaces, and case, matching the engramory
// slug discipline notes and filenames must both follow.
const SCOPE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Tests whether value is a project-scope slug (not a named scope). */
export function isScopeSlug(value: string): boolean {
  return SCOPE_SLUG_PATTERN.test(value)
}

/** Tests whether value is a named scope constant or a valid project slug. */
export function isScopeType(value: string): boolean {
  return (SCOPE_TYPES as readonly string[]).includes(value) || isScopeSlug(value)
}

/**
 * PLUGIN_VAULT_DIR names the plugin-internal directory inside every vault
 * root. The indexer skips it through the dot-directory rule; the vault root
 * itself is the indexed note root, so notes need no directory constant.
 */
export const PLUGIN_VAULT_DIR = '.obsidian-mem'
/** VAULT_METADATA_DIR names the sidecar dir under PLUGIN_VAULT_DIR. */
export const VAULT_METADATA_DIR = 'metadata'
/**
 * PLUGIN_METADATA_REL is the slash-joined relative path of the sidecar dir
 * inside a vault root (`.obsidian-mem/metadata`). Report messages and the
 * seeded dream prompt name the placement through this constant so prose
 * cannot drift from the layout; core's metadataDir() is the absolute-path
 * seam.
 */
export const PLUGIN_METADATA_REL = `${PLUGIN_VAULT_DIR}/${VAULT_METADATA_DIR}`

/**
 * INTENTS_FILE is the seeded file listing the intent markers, homed at the
 * vault root. Its name stays reserved from indexing at any depth.
 */
export const INTENTS_FILE = '.INTENTS.md'
/**
 * DREAMS_FILE is the dream diary memory_dream appends, kept at
 * `<vault>/.obsidian-mem/metadata/DREAMS.md`. Its name stays reserved at any
 * depth so a stray copy is never indexed.
 */
export const DREAMS_FILE = 'DREAMS.md'
/** Suffix of archive-history notes moved out of oversized notes. */
export const ARCHIVE_HISTORY_SUFFIX = '_history.md'
/**
 * GLOBAL_MEMORY_FILE_DEFAULT is a vault's global memory file path relative
 * to the vault root when its config leaves globalFile blank or omitted.
 */
export const GLOBAL_MEMORY_FILE_DEFAULT = 'GLOBAL.md'

/**
 * RESERVED_NON_INDEXED lists the reserved protocol names excluded from the
 * note tree at any depth: the note walker drops a file with one of these
 * names wherever it appears in a vault. Archive-history notes join them by
 * suffix; isReservedNonIndexed covers both halves. core's
 * isReservedVaultFile is the single any-depth rule the write tiers ride.
 */
export const RESERVED_NON_INDEXED = [INTENTS_FILE, DREAMS_FILE] as const

/**
 * Tests whether a file name is a reserved protocol name or an
 * archive-history note. Callers match it against a file's final path part,
 * so a reserved name is excluded from the note tree at any depth.
 */
export function isReservedNonIndexed(fileName: string): boolean {
  return (RESERVED_NON_INDEXED as readonly string[]).includes(fileName)
    || fileName.endsWith(ARCHIVE_HISTORY_SUFFIX)
}

// The dotted $HOME dirs these paths live under. Named here so dbDir,
// modelCacheDir, and the vault path stay anchored to one layout.
const DSH_DIR = '.dsh'
const PLUGIN_DIR = 'obsidian-mem'
const PLUGIN_DB_DIR = 'obsidian-mem-db'
const MODELS_DIR = 'models'
const STATE_DIR = 'state'
const DB_FILE = 'memory.db'

/** Builds the default shared-vault path `homedir/.dsh/obsidian-mem`. */
export function defaultVaultPath(homedir: string): string {
  return join(homedir, DSH_DIR, PLUGIN_DIR)
}

/** Builds the Milvus-Lite data dir `homedir/.dsh/obsidian-mem-db`. */
export function dbDir(homedir: string): string {
  return join(homedir, DSH_DIR, PLUGIN_DB_DIR)
}

/** Builds the Milvus-Lite database location under dbDir. */
export function dbFile(homedir: string): string {
  return join(dbDir(homedir), DB_FILE)
}

/**
 * Builds the transformers.js model cache dir under the Milvus db dir
 * (`$HOME/.dsh/obsidian-mem-db/models`). It sits outside the vaults so a
 * vault holds notes plus sidecars only.
 */
export function modelCacheDir(homedir: string): string {
  return join(dbDir(homedir), MODELS_DIR)
}

/** Builds the plugin state dir (indexer + audit state) under dbDir. */
export function stateDir(homedir: string): string {
  return dbStateDir(dbDir(homedir))
}

/** Builds the plugin state dir under an already-resolved dbPath. */
export function dbStateDir(dbPath: string): string {
  return join(dbPath, STATE_DIR)
}

/** Tag name that fences injected recalled memory in agent context. */
export const RECALLED_TAG = 'recalled_memory'

// The open tag's attribute carrying the source path. RECALLED_OPEN and
// the RECALLED_SEGMENT regex both interpolate it, so the tag shape has
// one definition.
const RECALLED_SOURCE_ATTR = 'source'

/**
 * RECALLED_OPEN builds the opening `<recalled_memory source="...">` tag
 * for an absolute source path, escaping the attribute so a path containing
 * quotes or angle brackets cannot break out of it. Named in caps to pair
 * with the RECALLED_CLOSE constant it wraps.
 */
export function RECALLED_OPEN(source: string): string {
  return `<${RECALLED_TAG} ${RECALLED_SOURCE_ATTR}="${escapeAttribute(source)}">`
}

/** Closing counterpart of RECALLED_OPEN. */
export const RECALLED_CLOSE = `</${RECALLED_TAG}>`

/** What defangRecalled substitutes for a literal closing tag. */
export const CLOSE_TAG_DEFANG = '[close-tag defanged]'

/**
 * DefangRecalled rewrites every literal `</recalled_memory>` sequence in
 * body to CLOSE_TAG_DEFANG. Vault notes are human-editable, so injected
 * text must not be able to close the envelope early and pose as harness
 * prose; every wrapRecalled caller gets this pass by construction.
 */
export function defangRecalled(body: string): string {
  return body.split(RECALLED_CLOSE).join(CLOSE_TAG_DEFANG)
}

/** Wraps body in the recalled-memory tags for source, defanging its content. */
export function wrapRecalled(source: string, body: string): string {
  return `${RECALLED_OPEN(source)}\n${defangRecalled(body)}\n${RECALLED_CLOSE}`
}

/** A parsed recalled-memory segment: its source path and inner body. */
export interface RecalledSegment {
  source: string
  body: string
}

// Anchored at both ends: the wrapper is a whole message/section, never an
// interior fragment, so recall budget accounting can strip it exactly.
const RECALLED_SEGMENT = new RegExp(
  `^<${RECALLED_TAG} ${RECALLED_SOURCE_ATTR}="([^"]*)">\\n([\\s\\S]*)\\n</${RECALLED_TAG}>$`,
)

/** Unwraps a whole recalled-memory segment back to source and body. */
export function unwrapRecalled(text: string): RecalledSegment | null {
  const match = RECALLED_SEGMENT.exec(text)
  if (!match) {
    return null
  }
  return { source: unescapeAttribute(match[1] ?? ''), body: match[2] ?? '' }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Name of the memory_read tool. */
export const TOOL_MEMORY_READ = 'memory_read'
/** Name of the memory_search tool. */
export const TOOL_MEMORY_SEARCH = 'memory_search'
/** Name of the memory_write tool. */
export const TOOL_MEMORY_WRITE = 'memory_write'
/** Name of the memory_dream tool. */
export const TOOL_MEMORY_DREAM = 'memory_dream'
/** Name of the memory_audit tool. */
export const TOOL_MEMORY_AUDIT = 'memory_audit'

/** The five model-facing tool names this plugin registers. */
export const MEMORY_TOOL_NAMES = [
  TOOL_MEMORY_READ,
  TOOL_MEMORY_SEARCH,
  TOOL_MEMORY_WRITE,
  TOOL_MEMORY_DREAM,
  TOOL_MEMORY_AUDIT,
] as const

/** Source kind this plugin tags its injected messages with. */
export const PLUGIN_SOURCE_KIND = 'plugin:obsidian-mem'

/** Name the plugin's system-prompt section registers under. */
export const SYSTEM_PROMPT_SECTION_NAME = 'obsidian-mem'
/** Order placing the memory section after the standing 9500-tier sections. */
export const SYSTEM_PROMPT_SECTION_ORDER = 9600

/** Token budget one turn-start recall injection may spend. */
export const RECALL_TURN_START_TOKENS = 1200
/** Token budget each section of a Read-tool recall may spend. */
export const RECALL_READ_SECTION_TOKENS = 350
/** Number of sections the Read-tool intercept recalls at most. */
export const RECALL_READ_MAX_SECTIONS = 2
/** Token budget the global per-session memory injection may spend. */
export const GLOBAL_MEMORY_TOKENS = 1500
/** Default result count memory_search returns when the caller omits topK. */
export const SEARCH_DEFAULT_TOP_K = 6
/** Hard cap on any search result count, however the caller asks. */
export const SEARCH_MAX_RESULTS = 20
/** Token ceiling one chunk may reach before the chunker splits it. */
export const CHUNK_MAX_TOKENS = 500

/** Default row cap for one memory_audit call; rollups cover the whole store. */
export const AUDIT_DEFAULT_LIMIT = 50
/** Largest row cap one memory_audit call may ask for; bigger requests clamp. */
export const AUDIT_MAX_LIMIT = 500

/**
 * AUDIT_NOTE_READ_CAP_BYTES is the doctor read cap: a note past it is
 * flagged, not read. The audit enumerates an attacker-influenceable store,
 * and a planted or runaway file must not exhaust the backstop meant to
 * report it (engramory doctor NOTE_READ_CAP canon).
 */
export const AUDIT_NOTE_READ_CAP_BYTES = 4 * 1024 * 1024

/**
 * NOTE_TIMELINE_BYTES marks a note as a timeline: keep the conclusion, move
 * the history out to a `<slug>_history.md` archive note (engramory 0.12.0
 * lesson: a PR-by-PR grown note is the common bloat shape).
 */
export const NOTE_TIMELINE_BYTES = 12_288

/** Editable dream protocol file, seeded once into <dbDir> by memory_dream. */
export const DREAM_PROMPT_FILE = 'dream-prompt.md'
/** Plugin dream stamp (`{lastDreamAt}`) under <dbDir>/state/. */
export const DREAM_STATE_FILE = 'state.json'
/**
 * RELEVANCY_FILE is the <dbDir>/state/ sidecar holding path→score relevancy.
 * Scores live outside the vaults on purpose (engramory-ext Q3): dreaming
 * commits and note edits stay about the memory, not the bookkeeping.
 */
export const RELEVANCY_FILE = 'relevancy.json'
/** Session id prefix of one dream agent run: dream-<uuid>. */
export const DREAM_SESSION_PREFIX = 'dream-'

/**
 * DREAM_NEAR_DUPLICATE_THRESHOLD is the default pairwise cosine at or above
 * which two notes join a near-duplicate cluster; the config knob is
 * dreaming.nearDuplicateThreshold.
 */
export const DREAM_NEAR_DUPLICATE_THRESHOLD = 0.92

/**
 * RELEVANCY_BUMP_TARGET and DEGRADATION_STEP are the deterministic
 * post-dream scoring constants measured purely from frontmatter read
 * evidence (read_count, last_read_at): a note accessed since the last dream
 * is scored at the bump target, a tracked but un-accessed note decays one
 * step per dream (floor 0).
 */
export const RELEVANCY_BUMP_TARGET = 1.0
export const DEGRADATION_STEP = 0.1

// Heuristic used everywhere a budget is enforced before a tokenizer runs;
// ~4 Latin characters per token is the standard rough estimate.
const APPROX_CHARS_PER_TOKEN = 4

/** Estimates the token count of text at ~4 characters per token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

/** ClampInt holds value inside the closed range [min, max]. */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * ApproxCharsForTokens converts a token budget into the character cut
 * approxTokens reads back as that budget (budget * 4, floored at one token so
 * a zero or negative budget still shows something). Every per-result text
 * budget applies this cut before any tokenizer runs.
 */
export function approxCharsForTokens(tokens: number): number {
  return Math.max(1, Math.trunc(tokens)) * APPROX_CHARS_PER_TOKEN
}

/** Name of the single Milvus collection holding every vault's chunks. */
export const MILVUS_COLLECTION = 'obsidian_mem'

/**
 * MILVUS_FIELDS maps each schema column to its Milvus field name. Schema
 * creation, inserts, filters, and search output lists all read from here so
 * a rename touches one place. sparseVector carries the BM25 function output
 * when the schema enables it.
 */
export const MILVUS_FIELDS = {
  chunkId: 'chunk_id',
  sourcePath: 'source_path',
  sectionHeader: 'section_header',
  chunkText: 'chunk_text',
  vault: 'vault',
  scope: 'scope',
  triggerExtensions: 'trigger_extensions',
  triggerFrameworks: 'trigger_frameworks',
  wakeKeywords: 'wake_keywords',
  denseVector: 'dense_vector',
  sparseVector: 'sparse',
  updatedAt: 'updated_at',
} as const

/** One of the Milvus schema field names. */
export type MilvusField = typeof MILVUS_FIELDS[keyof typeof MILVUS_FIELDS]

/**
 * MILVUS_ARRAY_CAPACITIES maps each Array<VarChar> column to the
 * max_capacity the collection declares. Trigger extraction caps its lists
 * here so an insert can never overflow the stored array; schema.ts builds
 * the columns from the same numbers.
 */
export const MILVUS_ARRAY_CAPACITIES = {
  triggerExtensions: 64,
  triggerFrameworks: 64,
  wakeKeywords: 96,
} as const

/**
 * MILVUS_ARRAY_ELEMENT_MAX_LENGTHS maps each Array<VarChar> column to the
 * per-element max_length; extraction drops candidates longer than this
 * rather than silently truncating a keyword into a different word.
 */
export const MILVUS_ARRAY_ELEMENT_MAX_LENGTHS = {
  triggerExtensions: 32,
  triggerFrameworks: 64,
  wakeKeywords: 64,
} as const

/**
 * MILVUS_SCALAR_MAX_LENGTHS maps each scalar VarChar column to the max_length
 * the collection declares. schema.ts builds the columns and the indexer
 * clamps every insert to the same numbers, so no stored value can overflow
 * its column and a width change lands in this one row.
 */
export const MILVUS_SCALAR_MAX_LENGTHS = {
  sourcePath: 1024,
  sectionHeader: 512,
  chunkText: 65_535,
  vault: 256,
  scope: 64,
} as const

/**
 * MILVUS_CONSISTENCY_LEVEL names the level the plugin pins on both sides of a
 * read: createCollection declares it and every search asks for it per request,
 * because SDK 3.0.6's ClientConfig has no client-level setting and lite must
 * answer read-after-write.
 */
export const MILVUS_CONSISTENCY_LEVEL = 'Strong'

/**
 * Vector width stored by default: multilingual-e5-small's true width. The
 * research decision log retired the original "768" (that is e5-base); no
 * lossy truncation happens unless the user opts into one below.
 */
export const VECTOR_DIM_DEFAULT = 384

/** Lossy truncation widths a user may opt into; each forces a re-index. */
export const VECTOR_DIM_LOSSY = [128, 192, 256, 320] as const

/** Tests whether value is the full width or an opted-in lossy width. */
export function isVectorDim(value: number): boolean {
  return value === VECTOR_DIM_DEFAULT
    || (VECTOR_DIM_LOSSY as readonly number[]).includes(value)
}

/** Embedding model id; e5-base (768-d) is the swap for true 768. */
export const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small'
/** Prefix transformers.js requires on indexed passages. */
export const PASSAGE_PREFIX = 'passage: '
/** Prefix transformers.js requires on search queries. */
export const QUERY_PREFIX = 'query: '

/**
 * TRANSFORMERS_PIPELINE_OPTIONS carries the @huggingface/transformers v4
 * pipeline options verbatim. v4 renamed `normalization` to `normalize` and
 * silently ignores the old key, so this exact spelling is load-bearing.
 */
export const TRANSFORMERS_PIPELINE_OPTIONS = {
  pooling: 'mean',
  normalize: true,
  dtype: 'q8',
} as const
