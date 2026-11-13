# TASK-020 Embedder (@huggingface/transformers e5-small)

Depends: TASK-010. Consult `docs/research/milvus-transformers-findings.md` (research
deliverable) first; prefer its verified pipeline options. `packages/service/src/embedder.ts`.

## Scope

- Lazy singleton pipeline (transformers.js 4.x VERIFIED option names, findings §6.1):
  `pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })` then
  call with `{ pooling: 'mean', normalize: true }`. The v3 spelling `normalization:true`
  is SILENTLY IGNORED in v4 (vectors come back un-normalized). Assert ‖v‖≈1 once at
  startup and fail loudly otherwise. q8 file is `model_quantized.onnx` (118 MB; +17 MB
  tokenizer; fp32-vs-q8 cosine ≥0.994 with identical rankings).
- `env.cacheDir = modelCacheDir()` (mkdir -p; per Q5, honored on Node),
  `env.allowRemoteModels = true`, `env.allowLocalModels = false`.
- `embedPassages(texts[])` (prefix "passage: "), `embedQuery(text)` (prefix "query: "),
  batching (32), 384-d output (dim = config vectorDim; when <384 slice + RENORMALIZE,
  documented LOSSY, and force re-index). Prefixes are load-bearing (verified ranking
  flip without them) and belong at embed time only — stored chunk_text stays clean so
  BM25 is not polluted.
- Single-flight load; concurrency queue; clear error text when offline + not cached
  (points at scripts/prefetch-model.mjs).
- `scripts/prefetch-model.mjs`: standalone download into modelCacheDir().
- Fake embedder (deterministic hash→vector) exported for tests of other modules.

## DoD

Unit tests with fake; a slow-tagged smoke test (skipped unless RUN_LIVE=1) asserting
cosine("passage: a cat" vs "query: cat") > unrelated pair and norm≈1; commit.
