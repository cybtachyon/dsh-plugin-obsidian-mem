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
    /** Vault-relative source file path; its own name is an extension signal. */
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
 * ExtractTriggers computes the three trigger lists for one chunk.
 * Overrides win wholesale: a frontmatter `trigger_extensions:` or
 * `trigger_frameworks:` replaces the heuristics for that field (the
 * author's explicit vocabulary beats detection). `keywords:` only
 * prepends; text signals still contribute wake keywords. Order is
 * deterministic: frontmatter first, then fence/inline/manifest/header/
 * emphasis/marker discovery order, deduplicated, lowercased, capped.
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
/** One Array<VarChar> trigger column, keyed as in the constants records. */
export type TriggerArrayColumn = keyof typeof MILVUS_ARRAY_CAPACITIES;
//# sourceMappingURL=triggers.d.ts.map
