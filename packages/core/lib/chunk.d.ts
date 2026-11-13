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
/** One retrieval chunk; field names mirror the Milvus columns. */
export interface Chunk {
    /** Vault-relative file the chunk came from. */
    source_path: string;
    /** Header path joined with " > ", e.g. "A > B > C"; '' above any header. */
    section_header: string;
    /** 16-hex hash of the header path plus a normalized text fragment. */
    header_hash: string;
    /** Index within one section; keeps ids unique per (source_path, header_hash, part). */
    part: number;
    /** section_header line (when present) plus the section body. */
    chunk_text: string;
    /** approxTokens of chunk_text, from constants. */
    approxTokens: number;
}
/** A header level fed to the splitter: its token and metadata key. */
export interface HeaderSpec {
    /** Leading token, e.g. "##". */
    token: string;
    /** Metadata key the header populates, e.g. "H2". */
    name: string;
}
/** The file to chunk: a vault-relative path plus its Markdown text. */
export interface ChunkInput {
    source_path: string;
    text: string;
}
/** Knobs for one chunkMarkdown call. */
export interface ChunkOptions {
    /** Levels to split on; defaults to all six ATX levels H1..H6. */
    headers?: readonly HeaderSpec[];
    /** Token ceiling per chunk before the secondary split. */
    maxTokens?: number;
}
/**
 * chunkMarkdown splits one Markdown file into retrieval chunks. Front
 * matter is stripped first (the ported splitter gives it no special
 * treatment), sections are aggregated, and any section over maxTokens
 * goes through splitLongChunk. Each chunk's stored text opens with its
 * "A > B > C" header path so embeddings keep the section context.
 */
export declare function chunkMarkdown(input: ChunkInput, options?: ChunkOptions): Chunk[];
/**
 * splitLongChunk splits one oversized chunk at paragraph boundaries
 * first, then sentence boundaries, then hard character cuts, packing
 * the pieces greedily so every part's approxTokens stays within
 * maxTokens unless the header path alone exceeds it. Parts are renumbered
 * 0..n so chunk ids stay unique per (source_path, header_hash, part).
 */
export declare function splitLongChunk(chunk: Chunk, maxTokens?: number): Chunk[];
/**
 * stripNoise removes retrieval noise from text destined for embedding:
 * YAML front matter, HTML comments, image data/base64 URIs (bare and in
 * link syntax), angle-bracket autolinks, and repeated blank lines. Apply
 * it to a copy of chunk_text; the stored chunk keeps headers and fences.
 */
export declare function stripNoise(text: string): string;
//# sourceMappingURL=chunk.d.ts.map
