/**
 * Deterministic hashing for chunk identity and content staleness:
 * section hashes, Int64-safe chunk ids, and sha256 content hashes. All
 * pure over node:crypto; no fs, no env. Ids and hashes depend only on
 * their explicit inputs, so a re-run over unchanged inputs never churns
 * the vector store.
 * @module dsh-plugin-obsidian-mem/core/idhash
 */
import { createHash } from 'node:crypto';
// 16 hex chars = the top 64 bits of the sha256 digest, ample to
// distinguish header paths within one vault's chunk set.
const HEADER_HASH_HEX_CHARS = 16;
// Chunk ids land in a Milvus Int64 column but must survive a JS number
// round-trip, so the digest is masked to the low 53 bits (which also
// clears the signed-int64 top bit): every id is a positive
// Number.MAX_SAFE_INTEGER-safe integer. Tradeoff: 53-bit id space makes
// a birthday collision roughly 1e-4 likely only around a million
// chunks, negligible at this plugin's expected scale, and a collision
// would mean one overlapping chunk row, not data corruption.
const CHUNK_ID_53_BIT_MASK = (1n << 53n) - 1n;
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
export function chunkId(parts) {
    const canonical = [
        parts.vault,
        parts.source_path,
        parts.header_hash,
        String(parts.part),
        parts.modelId,
        String(parts.vectorDim),
    ].join('\n');
    const wide = createHash('sha256').update(canonical, 'utf8').digest().readBigUInt64BE(0);
    return Number(wide & CHUNK_ID_53_BIT_MASK);
}
/**
 * contentHash renders data as its 64-char lowercase sha256 hex digest.
 * The indexer compares it against stored hashes to skip unchanged
 * files, and memory_write uses it for staleness checks.
 */
export function contentHash(data) {
    return createHash('sha256').update(data).digest('hex');
}
/**
 * headerHash hashes a section key (header path plus a normalized text
 * fragment, concatenated) to a 16-char lowercase hex sha256 prefix.
 * Chunkers pass `section_header + "\n" + fragment` so two sections that
 * share a header path still get distinct hashes.
 */
export function headerHash(sectionKey) {
    return createHash('sha256')
        .update(sectionKey, 'utf8')
        .digest('hex')
        .slice(0, HEADER_HASH_HEX_CHARS);
}
//# sourceMappingURL=idhash.js.map
