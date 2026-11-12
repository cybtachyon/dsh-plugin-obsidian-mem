# TASK-015 Deterministic chunk_id + content hashing

Depends: TASK-010. `packages/core/src/idhash.ts`.

## Scope

- `chunkId({vault, source_path, header_hash, part})` → Int64-safe number:
  sha256 of a canonical join (`vault\nsource_path\nheader_hash\npart`), first 8 bytes read
  BE, folded into signed int64 range (clear top bit, keep Number.MAX_SAFE_INTEGER-safe by
  masking to 53 bits — document the tradeoff: 53-bit ids, collision probability negligible
  at expected scale).
- `headerHash(headerPath + normalizedSectionTextFragment)` sha256 → hex prefix 16 chars.
- `contentHash(buffer)` sha256 hex (incremental indexing + memory_write staleness).
- All pure; no fs.

## DoD

Stability tests (same inputs → same id across runs), distribution smoke (10k random inputs,
zero collisions, ids within safe range), negative tests for canonicalization order; commit.
