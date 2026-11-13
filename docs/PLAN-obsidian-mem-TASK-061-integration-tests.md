# TASK-061 Integration tests (live tier, opt-in)

Status: done (2026-11-12: `RUN_LIVE=1 pnpm test` green on this machine;
live tier 11 tests / 6.4 s total with warm caches; default `pnpm test`
does not collect `*.live.test.ts` at all. Exposes and fixes one real
shipped bug: ARRAY_CONTAINSAny rejected by the lite 3.2.2 parser
(search.ts switched to ARRAY_CONTAINS_ANY; see findings correction).)

Depends: TASK-060. `tests/integration/*.live.test.ts` — vitest excludes `*.live.*` unless
`RUN_LIVE=1`.

## Scope

- Live tier (tmp HOME via env overrides the plugin honors: state/db/model dirs must all be
  env-injectable — enforce via a `paths.ts` override hook designed into service config):
  1. transformers.js real model (download once into tmp cacheDir; assert output dim 384,
     cosine sanity: related pair > unrelated; norms ~1.000 (catches the normalize-vs-
     normalization v4 trap); query/passage prefixes used).
  2. milvus-lite real spawn (uvx; warm cache assumed; generous timeouts per G13) into
     tmp db dir: ensureCollection → insert 20 chunks
     (from fixture vault via real chunker+embedder) → hybrid search returns expected
     source_path → ARRAY_CONTAINS ext filter excludes non-matching → delete by chunk_id →
     count drops; collection drop at teardown; child process killed (verify pid gone).
  3. memory_write→reindex→memory_search round-trip through the service API.
- Timeouts generous (model download); documented in README dev section.

## DoD

Both tiers pass: default `pnpm test` green offline; `RUN_LIVE=1 pnpm test` green on this
machine; commits.
