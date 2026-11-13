/**
 * Deterministic hashing for chunk identity and content staleness:
 * section hashes, Int64-safe chunk ids, and sha256 content hashes. All
 * pure over node:crypto; no fs, no env. Ids and hashes depend only on
 * their explicit inputs, so a re-run over unchanged inputs never churns
 * the vector store.
 * @module dsh-plugin-obsidian-mem/core/idhash
 */
/** The inputs that make one chunk's identity unique and model-scoped. */
export interface ChunkIdParts {
    /** Vault the source file belongs to. */
    vault: string;
    /** Vault-relative source file path. */
    source_path: string;
    /** headerHash of the section the chunk belongs to. */
    header_hash: string;
    /** Part index within the section (from the long-chunk split). */
    part: number;
    /** Embedding model id the chunk's vector came from. */
    modelId: string;
    /** Vector width the model was used at. */
    vectorDim: number;
}
/**
 * chunkId folds the sha256 of the canonical join
 * "vault\nsource_path\nheader_hash\npart\nmodelId\nvectorDim" (first 8
 * bytes read big-endian, masked to 53 bits) into a positive safe
 * integer. Position and type are part of the identity: swapping two
 * fields' values changes the id. modelId and vectorDim are baked in on
 * purpose: a model or dim swap yields fresh ids for every chunk, so the
 * indexer's state diff deletes stale rows instead of ever mixing
 * dimensions in one collection (full re-embed on swap).
 */
export declare function chunkId(parts: ChunkIdParts): number;
/**
 * contentHash renders data as its 64-char lowercase sha256 hex digest.
 * The indexer compares it against stored hashes to skip unchanged
 * files, and memory_write uses it for staleness checks.
 */
export declare function contentHash(data: string | Uint8Array): string;
/**
 * headerHash hashes a section key (header path plus a normalized text
 * fragment, concatenated) to a 16-char lowercase hex sha256 prefix.
 * Chunkers pass `section_header + "\n" + fragment` so two sections that
 * share a header path still get distinct hashes.
 */
export declare function headerHash(sectionKey: string): string;
//# sourceMappingURL=idhash.d.ts.map
