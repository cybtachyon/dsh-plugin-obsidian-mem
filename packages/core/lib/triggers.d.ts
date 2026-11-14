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
import { MILVUS_ARRAY_CAPACITIES } from './constants.js';
/** Frontmatter plus chunk context for one extractTriggers call. */
export interface TriggerInput {
    /**
     * Raw note frontmatter (Note.raw from parseNote). Read keys:
     * `trigger_extensions` and `trigger_frameworks` (whole-list overrides)
     * and `keywords` (prepended wake keywords). Absent keys mean pure
     * text heuristics.
     */
    noteMeta?: Record<string, unknown>;
    /** The chunk's stored text (chunk_text), header path line included. */
    sectionText: string;
    /** Vault-relative source file path; its own name is an extension and wake-word signal. */
    filePath: string;
    /** Framework labels from the workspace manifest; applied only when the section text names them. */
    manifestVocabulary?: TriggerVocabulary;
}
/** Workspace-manifest signals the heuristics may consult. */
export interface TriggerVocabulary {
    /** Framework labels (WorkspaceManifest.frameworks and friends). */
    frameworks?: readonly string[];
}
/** The three Array<VarChar> trigger columns, extraction-ready. */
export interface Triggers {
    trigger_extensions: string[];
    trigger_frameworks: string[];
    wake_keywords: string[];
}
/**
 * WAKE_KEYWORD_MIN_LENGTH is the shortest term the legality gate accepts:
 * a single character carries no retrieval signal. Exported because the
 * service sparse wake gate applies the SAME legality floor to query tokens
 * (search.ts sparseWakeFilterTokens) and imports it rather than restating
 * the number; the element ceiling is the shared
 * MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords.
 */
export declare const WAKE_KEYWORD_MIN_LENGTH = 2;
/**
 * ExtractTriggers computes the three trigger lists for one chunk.
 * Overrides win wholesale: a frontmatter `trigger_extensions:` or
 * `trigger_frameworks:` replaces the heuristics for that field (the
 * author's explicit vocabulary beats detection). `keywords:` only
 * prepends; text signals still contribute wake keywords. Order is
 * deterministic: frontmatter and file-name words first, then
 * fence/inline/manifest/header/emphasis/marker discovery order, then
 * the text's maximal Han runs, deduplicated, lowercased,
 * legality-filtered, capped.
 */
export declare function extractTriggers(input: TriggerInput): Triggers;
/**
 * NormalizeExtension renders ".ts", "ts", ".TS ", and " .tsx" to one dotted
 * lowercase form, and returns null for anything left of that. It defines the
 * canonical spelling of a trigger extension: the extractor stores values
 * through it, so a search filter must normalize its candidate the same way to
 * match a stored trigger_extensions element.
 */
export declare function normalizeExtension(raw: string): string | null;
/**
 * IsUsableKeyword is the ONE legality gate every wake candidate passes,
 * whichever path harvested it (frontmatter, file name, header, emphasis,
 * intent marker, Han run). Exported so external merges (the service
 * LlmRefiner) run endpoint vocabulary through this same gate, never a
 * second one. A keyword must be at least 2 chars, at most the
 * schema element cap, and few enough words to behave like a keyword, not a
 * sentence; must not be a generic house-format label (the TASK-001 audit
 * showed those dominating the corpus wake vocabulary); must not be entirely
 * Han function-word characters (the TASK-017 Han harvest mirrors the
 * analyzer-strip's whole-run noise rule); must open with a letter, balance
 * its parens/brackets/braces, and carry no internal em dash, so digit- and
 * symbol-led cut fragments cannot pass (the same audit's tail: "0 of 54",
 * "2/(k+1", "+ `field.field`", a 54-char em-dashed sentence fragment).
 */
export declare function isUsableKeyword(keyword: string): boolean;
/** One Array<VarChar> trigger column, keyed as in the constants records. */
export type TriggerArrayColumn = keyof typeof MILVUS_ARRAY_CAPACITIES;
/**
 * CapColumn enforces one column's contract on a trigger list: it drops
 * elements longer than the column's max_length, then keeps
 * max_capacity entries. Both limits are read from the same column key, so a
 * list can never be capped against the wrong column (constants.ts).
 * Exported for the same reason as isUsableKeyword: a caller that appends
 * to a heuristic list (the service LlmRefiner merge) re-caps through this
 * function instead of trusting the list it received as already final.
 */
export declare function capColumn(values: readonly string[], column: TriggerArrayColumn): string[];
//# sourceMappingURL=triggers.d.ts.map
