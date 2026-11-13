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
/**
 * INTENT_MARKERS lists the nine recall-intent markers in canonical order.
 * .INTENTS.md seeds one section per marker; audit and the wake-keyword pass
 * enumerate this list as the single source of truth.
 */
export declare const INTENT_MARKERS: readonly ["who", "what", "when", "where", "how", "why", "investigate", "debug", "troubleshoot"];
/** One of the nine .INTENTS.md section markers. */
export type IntentMarker = typeof INTENT_MARKERS[number];
/** Tests whether value names one of the nine intent markers. */
export declare function isIntentMarker(value: string): value is IntentMarker;
/** Scope constant: a memory true across every vault and project. */
export declare const SCOPE_GLOBAL = "global";
/** Scope constant: a memory bound to one working domain. */
export declare const SCOPE_DOMAIN = "domain";
/** Scope constant: a memory pointing at external reference material. */
export declare const SCOPE_REFERENCE = "reference";
/** The three named scope constants; project scope is a slug instead. */
export declare const SCOPE_TYPES: readonly ["global", "domain", "reference"];
/** A named scope or, by isScopeSlug, a project slug. */
export type ScopeType = typeof SCOPE_TYPES[number];
/** Tests whether value is a project-scope slug (not a named scope). */
export declare function isScopeSlug(value: string): boolean;
/** Tests whether value is a named scope constant or a valid project slug. */
export declare function isScopeType(value: string): boolean;
/**
 * PLUGIN_VAULT_DIR names the plugin-internal directory inside every vault
 * root. The indexer skips it through the dot-directory rule; the vault root
 * itself is the indexed note root, so notes need no directory constant.
 */
export declare const PLUGIN_VAULT_DIR = ".obsidian-mem";
/** VAULT_METADATA_DIR names the sidecar dir under PLUGIN_VAULT_DIR. */
export declare const VAULT_METADATA_DIR = "metadata";
/** Vault-root file listing the intent markers; never indexed. */
export declare const INTENTS_FILE = ".INTENTS.md";
/**
 * DREAMS_FILE is the dream diary memory_dream appends, kept at
 * `<vault>/.obsidian-mem/metadata/DREAMS.md`. Its name stays reserved at the
 * vault root so a stray root copy is never indexed.
 */
export declare const DREAMS_FILE = "DREAMS.md";
/** Suffix of archive-history notes moved out of oversized notes. */
export declare const ARCHIVE_HISTORY_SUFFIX = "_history.md";
/**
 * GLOBAL_MEMORY_FILE_DEFAULT is a vault's global memory file path relative
 * to the vault root when its config leaves globalFile blank or omitted.
 */
export declare const GLOBAL_MEMORY_FILE_DEFAULT = "GLOBAL.md";
/**
 * RESERVED_NON_INDEXED lists the vault-root files the indexer and the audit
 * note enumeration must skip. Archive-history notes join them by suffix;
 * isReservedNonIndexed covers both halves.
 */
export declare const RESERVED_NON_INDEXED: readonly [".INTENTS.md", "DREAMS.md"];
/** Tests whether a vault-root file name is reserved from indexing. */
export declare function isReservedNonIndexed(fileName: string): boolean;
/** Builds the default shared-vault path `homedir/.dsh/obsidian-mem`. */
export declare function defaultVaultPath(homedir: string): string;
/** Builds the Milvus-Lite data dir `homedir/.dsh/obsidian-mem-db`. */
export declare function dbDir(homedir: string): string;
/** Builds the Milvus-Lite database location under dbDir. */
export declare function dbFile(homedir: string): string;
/**
 * Builds the transformers.js model cache dir under the Milvus db dir
 * (`$HOME/.dsh/obsidian-mem-db/models`). It sits outside the vaults so a
 * vault holds notes plus sidecars only.
 */
export declare function modelCacheDir(homedir: string): string;
/** Builds the plugin state dir (indexer + audit state) under dbDir. */
export declare function stateDir(homedir: string): string;
/** Builds the plugin state dir under an already-resolved dbPath. */
export declare function dbStateDir(dbPath: string): string;
/** Tag name that fences injected recalled memory in agent context. */
export declare const RECALLED_TAG = "recalled_memory";
/**
 * RECALLED_OPEN builds the opening `<recalled_memory source="...">` tag
 * for an absolute source path, escaping the attribute so a path containing
 * quotes or angle brackets cannot break out of it. Named in caps to pair
 * with the RECALLED_CLOSE constant it wraps.
 */
export declare function RECALLED_OPEN(source: string): string;
/** Closing counterpart of RECALLED_OPEN. */
export declare const RECALLED_CLOSE = "</recalled_memory>";
/** What defangRecalled substitutes for a literal closing tag. */
export declare const CLOSE_TAG_DEFANG = "[close-tag defanged]";
/**
 * DefangRecalled rewrites every literal `</recalled_memory>` sequence in
 * body to CLOSE_TAG_DEFANG. Vault notes are human-editable, so injected
 * text must not be able to close the envelope early and pose as harness
 * prose; every wrapRecalled caller gets this pass by construction.
 */
export declare function defangRecalled(body: string): string;
/** Wraps body in the recalled-memory tags for source, defanging its content. */
export declare function wrapRecalled(source: string, body: string): string;
/** A parsed recalled-memory segment: its source path and inner body. */
export interface RecalledSegment {
    source: string;
    body: string;
}
/** Unwraps a whole recalled-memory segment back to source and body. */
export declare function unwrapRecalled(text: string): RecalledSegment | null;
/** Name of the memory_read tool. */
export declare const TOOL_MEMORY_READ = "memory_read";
/** Name of the memory_search tool. */
export declare const TOOL_MEMORY_SEARCH = "memory_search";
/** Name of the memory_write tool. */
export declare const TOOL_MEMORY_WRITE = "memory_write";
/** Name of the memory_dream tool. */
export declare const TOOL_MEMORY_DREAM = "memory_dream";
/** Name of the memory_audit tool. */
export declare const TOOL_MEMORY_AUDIT = "memory_audit";
/** The five model-facing tool names this plugin registers. */
export declare const MEMORY_TOOL_NAMES: readonly ["memory_read", "memory_search", "memory_write", "memory_dream", "memory_audit"];
/** Source kind this plugin tags its injected messages with. */
export declare const PLUGIN_SOURCE_KIND = "plugin:obsidian-mem";
/** Name the plugin's system-prompt section registers under. */
export declare const SYSTEM_PROMPT_SECTION_NAME = "obsidian-mem";
/** Order placing the memory section after the standing 9500-tier sections. */
export declare const SYSTEM_PROMPT_SECTION_ORDER = 9600;
/** Token budget one turn-start recall injection may spend. */
export declare const RECALL_TURN_START_TOKENS = 1200;
/** Token budget each section of a Read-tool recall may spend. */
export declare const RECALL_READ_SECTION_TOKENS = 350;
/** Number of sections the Read-tool intercept recalls at most. */
export declare const RECALL_READ_MAX_SECTIONS = 2;
/** Token budget the global per-session memory injection may spend. */
export declare const GLOBAL_MEMORY_TOKENS = 1500;
/** Default result count memory_search returns when the caller omits topK. */
export declare const SEARCH_DEFAULT_TOP_K = 6;
/** Hard cap on any search result count, however the caller asks. */
export declare const SEARCH_MAX_RESULTS = 20;
/** Token ceiling one chunk may reach before the chunker splits it. */
export declare const CHUNK_MAX_TOKENS = 500;
/** Default row cap for one memory_audit call; rollups cover the whole store. */
export declare const AUDIT_DEFAULT_LIMIT = 50;
/** Largest row cap one memory_audit call may ask for; bigger requests clamp. */
export declare const AUDIT_MAX_LIMIT = 500;
/**
 * AUDIT_NOTE_READ_CAP_BYTES is the doctor read cap: a note past it is
 * flagged, not read. The audit enumerates an attacker-influenceable store,
 * and a planted or runaway file must not exhaust the backstop meant to
 * report it (engramory doctor NOTE_READ_CAP canon).
 */
export declare const AUDIT_NOTE_READ_CAP_BYTES: number;
/**
 * NOTE_TIMELINE_BYTES marks a note as a timeline: keep the conclusion, move
 * the history out to a `<slug>_history.md` archive note (engramory 0.12.0
 * lesson: a PR-by-PR grown note is the common bloat shape).
 */
export declare const NOTE_TIMELINE_BYTES = 12288;
/** Editable dream protocol file, seeded once into <dbDir> by memory_dream. */
export declare const DREAM_PROMPT_FILE = "dream-prompt.md";
/** Plugin dream stamp (`{lastDreamAt}`) under <dbDir>/state/. */
export declare const DREAM_STATE_FILE = "state.json";
/**
 * RELEVANCY_FILE is the <dbDir>/state/ sidecar holding path→score relevancy.
 * Scores live outside the vaults on purpose (engramory-ext Q3): dreaming
 * commits and note edits stay about the memory, not the bookkeeping.
 */
export declare const RELEVANCY_FILE = "relevancy.json";
/** Session id prefix of one dream agent run: dream-<uuid>. */
export declare const DREAM_SESSION_PREFIX = "dream-";
/**
 * DREAM_NEAR_DUPLICATE_THRESHOLD is the default pairwise cosine at or above
 * which two notes join a near-duplicate cluster; the config knob is
 * dreaming.nearDuplicateThreshold.
 */
export declare const DREAM_NEAR_DUPLICATE_THRESHOLD = 0.92;
/**
 * RELEVANCY_BUMP_TARGET and DEGRADATION_STEP are the deterministic
 * post-dream scoring constants measured purely from frontmatter read
 * evidence (read_count, last_read_at): a note accessed since the last dream
 * is scored at the bump target, a tracked but un-accessed note decays one
 * step per dream (floor 0).
 */
export declare const RELEVANCY_BUMP_TARGET = 1;
export declare const DEGRADATION_STEP = 0.1;
/** Estimates the token count of text at ~4 characters per token. */
export declare function approxTokens(text: string): number;
/** ClampInt holds value inside the closed range [min, max]. */
export declare function clampInt(value: number, min: number, max: number): number;
/**
 * ApproxCharsForTokens converts a token budget into the character cut
 * approxTokens reads back as that budget (budget * 4, floored at one token so
 * a zero or negative budget still shows something). Every per-result text
 * budget applies this cut before any tokenizer runs.
 */
export declare function approxCharsForTokens(tokens: number): number;
/** Name of the single Milvus collection holding every vault's chunks. */
export declare const MILVUS_COLLECTION = "obsidian_mem";
/**
 * MILVUS_FIELDS maps each schema column to its Milvus field name. Schema
 * creation, inserts, filters, and search output lists all read from here so
 * a rename touches one place. sparseVector carries the BM25 function output
 * when the schema enables it.
 */
export declare const MILVUS_FIELDS: {
    readonly chunkId: "chunk_id";
    readonly sourcePath: "source_path";
    readonly sectionHeader: "section_header";
    readonly chunkText: "chunk_text";
    readonly vault: "vault";
    readonly scope: "scope";
    readonly triggerExtensions: "trigger_extensions";
    readonly triggerFrameworks: "trigger_frameworks";
    readonly wakeKeywords: "wake_keywords";
    readonly denseVector: "dense_vector";
    readonly sparseVector: "sparse";
    readonly updatedAt: "updated_at";
};
/** One of the Milvus schema field names. */
export type MilvusField = typeof MILVUS_FIELDS[keyof typeof MILVUS_FIELDS];
/**
 * MILVUS_ARRAY_CAPACITIES maps each Array<VarChar> column to the
 * max_capacity the collection declares. Trigger extraction caps its lists
 * here so an insert can never overflow the stored array; schema.ts builds
 * the columns from the same numbers.
 */
export declare const MILVUS_ARRAY_CAPACITIES: {
    readonly triggerExtensions: 64;
    readonly triggerFrameworks: 64;
    readonly wakeKeywords: 96;
};
/**
 * MILVUS_ARRAY_ELEMENT_MAX_LENGTHS maps each Array<VarChar> column to the
 * per-element max_length; extraction drops candidates longer than this
 * rather than silently truncating a keyword into a different word.
 */
export declare const MILVUS_ARRAY_ELEMENT_MAX_LENGTHS: {
    readonly triggerExtensions: 32;
    readonly triggerFrameworks: 64;
    readonly wakeKeywords: 64;
};
/**
 * MILVUS_SCALAR_MAX_LENGTHS maps each scalar VarChar column to the max_length
 * the collection declares. schema.ts builds the columns and the indexer
 * clamps every insert to the same numbers, so no stored value can overflow
 * its column and a width change lands in this one row.
 */
export declare const MILVUS_SCALAR_MAX_LENGTHS: {
    readonly sourcePath: 1024;
    readonly sectionHeader: 512;
    readonly chunkText: 65535;
    readonly vault: 256;
    readonly scope: 64;
};
/**
 * MILVUS_CONSISTENCY_LEVEL names the level the plugin pins on both sides of a
 * read: createCollection declares it and every search asks for it per request,
 * because SDK 3.0.6's ClientConfig has no client-level setting and lite must
 * answer read-after-write.
 */
export declare const MILVUS_CONSISTENCY_LEVEL = "Strong";
/**
 * Vector width stored by default: multilingual-e5-small's true width. The
 * research decision log retired the original "768" (that is e5-base); no
 * lossy truncation happens unless the user opts into one below.
 */
export declare const VECTOR_DIM_DEFAULT = 384;
/** Lossy truncation widths a user may opt into; each forces a re-index. */
export declare const VECTOR_DIM_LOSSY: readonly [128, 192, 256, 320];
/** Tests whether value is the full width or an opted-in lossy width. */
export declare function isVectorDim(value: number): boolean;
/** Embedding model id; e5-base (768-d) is the swap for true 768. */
export declare const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";
/** Prefix transformers.js requires on indexed passages. */
export declare const PASSAGE_PREFIX = "passage: ";
/** Prefix transformers.js requires on search queries. */
export declare const QUERY_PREFIX = "query: ";
/**
 * TRANSFORMERS_PIPELINE_OPTIONS carries the @huggingface/transformers v4
 * pipeline options verbatim. v4 renamed `normalization` to `normalize` and
 * silently ignores the old key, so this exact spelling is load-bearing.
 */
export declare const TRANSFORMERS_PIPELINE_OPTIONS: {
    readonly pooling: "mean";
    readonly normalize: true;
    readonly dtype: "q8";
};
//# sourceMappingURL=constants.d.ts.map
