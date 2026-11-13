/**
 * `memory_search`: hybrid recall over the indexed vaults, shaped for the
 * model as ranked sections (source path, section header, score, vault
 * access mode, token-capped snippet with an honest truncation flag). The
 * service dispatch runs with the chunker's own ceiling as its snippet
 * budget so the tool, not the dispatch, applies the per-section budget and
 * therefore knows exactly which snippets it clipped. An offline or crashed
 * index comes back as the `index_offline` value with remediation, never a
 * throw. The 300 s timeout budgets the cold start: the first query embeds
 * only after the embedding model may have downloaded (hundreds of MB).
 * @module dsh-plugin-obsidian-mem/tools/search
 */
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
/** Cold start budget: model download plus Milvus-Lite first spawn. */
export declare const SEARCH_TIMEOUT_MS = 300000;
/** What to tell the agent when the index cannot answer. */
export declare const INDEX_OFFLINE_REMEDIATION = "Retry the search once more: the first search waits on the memory index starting and the embedding model downloading, which can take minutes. If searches stay offline, check the Obsidian Mem settings (milvus mode and address) and restart the harness.";
/** The description the model sees for `memory_search`. */
export declare const SEARCH_DESCRIPTION = "Search the indexed memory vaults and return ranked sections: each result carries the source note path, the section header, a match score, the vault's access mode, and a token-capped snippet. Narrow with scope and ext filters. Follow a promising section with memory_read on its path for the full note.";
/** Parameter schema; defaults, ranges, and formats live on the parameters. */
export declare function searchParameters(defaultTopK: number): JsonSchemaNode;
/** Closed output union keyed on kind. */
export declare const SEARCH_OUTPUT: JsonSchemaNode;
/** One ranked section as the tool returns it. */
export interface SearchSection {
    path: string;
    section_header: string;
    scope: string;
    vault: string;
    vault_mode: 'shared' | 'read-only' | 'unknown';
    score: number;
    snippet: string;
    snippet_truncated: boolean;
}
/** The value one memory_search call returns. */
export type SearchValue = {
    kind: 'search';
    query: string;
    count: number;
    sections: SearchSection[];
    notice?: string;
} | {
    kind: 'index_offline';
    message: string;
    remediation: string;
    notice?: string;
};
/** Execute one memory_search call; an offline index is a value, not a throw. */
export declare function executeSearch(service: MemoryService, args: unknown): Promise<SearchValue>;
/** Model-facing rendering of one memory_search value. */
export declare function renderSearch(value: SearchValue): string;
/** Build the memory_search definition for one service seam. */
export declare function createSearchTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=search.d.ts.map
