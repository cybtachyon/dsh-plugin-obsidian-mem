# TASK-020 Embedder (@huggingface/transformers e5-small)

Depends: TASK-010. Consult `docs/research/milvus-transformers-findings.md` (research
deliverable) first; prefer its verified pipeline options. `packages/service/src/embedder.ts`.

## Scope

- Lazy singleton pipeline: `feature_extraction('Xenova/multilingual-e5-small', { quantized:
  true })` (or the verified pooler config; e5 needs mean pooling + normalize — verify the
  pipeline applies pooling; if not, use `pipeline('feature-extraction', ...)` with
  `{ pooling: true, normalization: true }` options and validate against a known pair).
- `env.cacheDir = modelCacheDir()` (mkdir -p; per Q5), `env.allowRemoteModels = true`,
  `env.allowLocalModels = true`.
- `embedPassages(texts[])` (prefix "passage: "), `embedQuery(text)` (prefix "query: "),
  batching (<=16), 768-d output (dim = config vectorDim; when <768 slice + renormalize per
  MRL caveat documented in constants).
- Single-flight load; concurrency queue; clear error text when offline + not cached
  (points at scripts/prefetch-model.mjs).
- `scripts/prefetch-model.mjs`: standalone download into modelCacheDir().
- Fake embedder (deterministic hash→vector) exported for tests of other modules.

## DoD

Unit tests with fake; a slow-tagged smoke test (skipped unless RUN_LIVE=1) asserting
cosine("passage: a cat" vs "query: cat") > unrelated pair and norm≈1; commit.
