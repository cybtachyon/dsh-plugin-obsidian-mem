/**
 * Deterministic hashing for chunk identity and content staleness:
 * section hashes, Int64-safe chunk ids, and sha256 content hashes. All
 * pure over node:crypto; no fs, no env. Ids and hashes depend only on
 * their explicit inputs, so a re-run over unchanged inputs never churns
 * the vector store.
 * @module dsh-plugin-obsidian-mem/core/idhash
 */

import { createHash } from 'node:crypto'

// 16 hex chars = the top 64 bits of the sha256 digest, ample to
// distinguish header paths within one vault's chunk set.
const HEADER_HASH_HEX_CHARS = 16

/**
 * headerHash hashes a section key (header path plus a normalized text
 * fragment, concatenated) to a 16-char lowercase hex sha256 prefix.
 * Chunkers pass `section_header + "\n" + fragment` so two sections that
 * share a header path still get distinct hashes.
 */
export function headerHash(sectionKey: string): string {
  return createHash('sha256')
    .update(sectionKey, 'utf8')
    .digest('hex')
    .slice(0, HEADER_HASH_HEX_CHARS)
}
