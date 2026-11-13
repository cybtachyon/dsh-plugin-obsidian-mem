# TASK-024 Hybrid search with ARRAY_CONTAINS filters

Status: done

Depends: TASK-022, TASK-023. `packages/service/src/search.ts`.

## Scope

- `search({ query, ext?, frameworks?, wakeKeywords?, scopes?, vaults?, topK?, minScore? })`
  → embedQuery → hybrid when BM25 available: `hybridSearch` dense ann + sparse ann with RRF
  fusion (`limit = topK*2` candidates, per-field weights 0.7/0.3 default); else dense
  search + client-side rerank boost for analyzer/keyword term overlap.
- Filter expression builder: `scope in [...]` (partition-key pruning),
  `ARRAY_CONTAINS(trigger_extensions, ".ts")`, `ARRAY_CONTAINSAny(trigger_frameworks,
  [...])`, `ARRAY_CONTAINSAny(wake_keywords, [...])`, `vault in [...]`; escape values
  (Milvus expr string quoting) — shared builder unit-tested against golden expressions.
- Results → `{ chunk_id, source_path, section_header, chunk_text, scope, vault, mode
  ('shared'|'read-only' via vault registry), updated_at, score }`; dedupe same
  source_path+section_header keeping best; truncate chunk_text to per-result token budget.
- `searchExactSections(filePath, {ext, dirSignals, snippet, k=2, sectionTokens=350})` for
  the Read intercept: filter `source_path == '<path>'` first; when no chunks for that
  exact file, fall back to ARRAY_CONTAINS(ext) + framework filters + query text.
- Guard: Milvus unavailable → typed `IndexOfflineError` (callers degrade quietly).

## Prior-art specifics (RESEARCH-FINDINGS.md §2 + VERIFIED API, milvus-transformers-findings §3/§4)

- Hybrid: `client.hybridSearch` (camelCase; sub-requests under **`data: [...]`**, NOT
  `requests:`; per-route filters in `expr`) with dense COSINE + BM25 and
  `RRFRanker(60)`. BM25 scores can be NEGATIVE (segment-local IDF) — never threshold
  BM25 at 0; rank fusion only. Sparse anns REQUIRE explicit `metric_type: BM25` in each
  `data[]` item (lite does not infer; error 6 otherwise). `WeightedRanker` takes ONE
  ARRAY `WeightedRanker([0.7,0.3])` (two args crashes the server). `searchIterator` is
  broken against lite — use `queryIterator`/offset paging. Serialize ALL writes in TS
  (lite allows concurrent readers, not writers).
- ALWAYS `loadCollectionSync` before search (lite 'released' trap; getLoadState lies) and
  count(*)-guard empty collections before dispatching BM25 (NaN crash).
- G10: lite projections omit the PK unless `chunk_id` is EXPLICITLY in `output_fields` —
  every search/query builder here must list it, plus scope/vault/source_path/
  section_header/updated_at.
- `ensureMemoryAccess` first (lazy default vault; Decision log).

## DoD

Golden-expression tests, dedupe/budget tests, offline degradation test (fakes); commit.
