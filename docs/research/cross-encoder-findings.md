# bge-reranker-base post-fusion rerank (TASK-012 findings)

Stack under test: `Xenova/bge-reranker-base` (XLM-RoBERTa
sequence-classification, num_labels 1, max 512 positions) under
`@huggingface/transformers` 4.3.2, dtype `q8`
(`onnx/model_quantized.onnx`, 266 MiB), CPU onnxruntime, node v26.12.0.
The candidate page reranked is the CURRENT production shape replayed live
(read-only) against `obsidian_mem` (`milvus_lite-3.2.2`, 200 rows at run
time 2026-11-13): dense COSINE radius 0.78 range_filter 1.0 ef 64 + BM25
with client floor `-score >= 2.5`, client RRF(60), fused floor 1/61, topK
6, oversample 2 (`packages/service/src/search.ts` constants). Scores are
`sigmoid(raw logit)`; the v4.3.2 `TextClassificationPipeline` softmax is
degenerate at one logit (constant 1.0) and is bypassed by calling
`classifier.model` directly (see `scripts/eval/cross-encoder-rerank.mjs`
header). Every scored passage is the raw `chunk_text` row truncated by the
tokenizer to the model window. Reproduce with:

```
node scripts/eval/cross-encoder-rerank.mjs
# fine sweep around the recall cliff:
node scripts/eval/cross-encoder-rerank.mjs --cutoffs none,0.001,0.002,0.0025,0.0028,0.003,0.0035,0.005,0.01,0.02,0.03,0.05,0.1,0.15,0.2,0.35
```

Two consecutive runs produced byte-identical JSON artifacts (`cmp` clean;
no timestamps; latency is stdout-only). The baseline row below ("none") is
the live production page of this run: 63 rows, P@k 0.286, forbidden-rate
0.206, recall-of-labeled 0.636. The committed TASK-003 baseline artifact
(`eval-split-d078-s25-k60-m0164.json`, 66 rows / 0.273 / 0.197 / 0.636)
drifted by 3 rows as the live corpus is expected to (scripts/eval/README.md
"Collections drift"); all comparisons below are internal to this run.

# Decision

**REJECT bge-reranker-base as a post-fusion reranker/cutoff for
production.** Not adopted; no cutoff constant is proposed. The reasons, in
order of weight:

1. **The spec's calibration rule has a degenerate optimum.** "Maximize
   noise-removal at zero relevant-source loss" (TASK-012 scope §2) lands
   at cutoff **0.0028**: the first relevant row dies at p = 0.00291
   (`typescript-simulation-style.md`, the only relevant row for the
   machinae-combat query). At 0.0028 the page is 45 rows, P@k 0.400,
   forbidden-rate 0.133, recall 0.636: real gains on paper, but the
   cutoff then only kills logits ≤ -5.8, i.e. the reranker acts as a
   deep-tail garbage filter, not the semantic arbiter TASK-012 was scoped
   to be.
2. **The residual forbidden rows survive exactly where the reranker and
   the labels disagree.** All 6 forbidden survivors at 0.0028 sit at
   p = 0.0045..0.0651, inside the band occupied by 6 of the 18 relevant
   rows (R probabilities run 0.003..0.999; F run 0.000..0.065). Removing
   every labeled forbidden row needs cutoff ≈ 0.07 and costs 5 relevant
   notes: recall collapses 0.636 → 0.409. The overlap band IS the
   design-relevance class: cross-vault platform notes labeled relevant on
   intent (`drupal/drupal11-entity-form-di.md` for a lywa DI query,
   p ≈ 0.031), generic guidance notes labeled relevant as the intended
   transfer (`typescript-simulation-style.md` for machinae-game,
   p = 0.003/0.069), and a bugfix note phrased differently from the bug
   report (`dream-run-agentoptions`, p = 0.003). A zero-shot semantic
   reranker scores them near zero because the *text* is not the query's
   topic; the recall system's job is precisely to surface them.
3. **It would worsen the live-loop failure it was queued to fix.** The
   PLAN-milvus-tuning.md iteration-1 replay's false-negative was
   `typescript-simulation-style.md` demoted by fusion and dropped by the
   floor. Rerank-before-floor (iteration-2 candidate (a)) does not
   rescue it: the same note carries cross-encoder p = 0.0029 and
   p = 0.069 on the two machinae queries, so any usable gate demotes it
   too. (Before-floor placement was NOT measured here; this task fixed
   the reranker input to the post-floor page.)
4. **The re-sort buys nothing on this page.** Mean index of the best
   relevant row: baseline 1.286 vs reranked 1.286 (n = 14 queries with a
   relevant hit). The fused page already puts the best relevant row at
   rank 1 wherever fusion found one.
5. **Cost without benefit.** Mean 534 ms/query CPU (63 rows over 17
   queries, 9.1 s total) plus ~0.7 s warm model load and 283 MB of cache
   in `<dbDir>/models`. Turn-start recall is fire-and-forget, but this
   pins a 280 MB session plus half a second of CPU on the user's machine
   per agent turn for a filter that cannot attack the residual forbidden
   rate.

**What the one defensible variant costs:** if a deep-tail gate is ever
wanted anyway, the calibrated zero-labeled-loss ceiling is p >= 0.003
(use 0.0025 to keep margin): 45 rows returned, 7 of 13 forbidden rows
dropped, 6 unlabeled-neutral and 6 acceptable rows also dropped, zero
labeled-relevant loss on this 17-query set. The margin is one row wide
(the cliff is set by a single 0.00291 chunk), and the surviving forbidden
half is untouched. That is not a fix for the ~0.20 forbidden rate.

**Reopen conditions:** a reranker that treats design-relevance (project/
instruction affinity) as a feature, fine-tuned on this vault's labels, or
evidence from the manifest-contamination work (iteration-2 candidate (b))
that the production noise population differs enough to change the
separability picture.

# Separability (probability distributions by label class)

All 63 scored rows, `sigmoid(logit)`, one row = (query, chunk):

| class | n | min | q1 | median | q3 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R (relevant) | 18 | 0.003 | 0.042 | 0.603 | 0.938 | 0.999 | 0.522 |
| A (acceptable) | 21 | 0.000 | 0.002 | 0.045 | 0.224 | 0.950 | 0.164 |
| F (forbidden) | 13 | 0.000 | 0.000 | 0.002 | 0.019 | 0.065 | 0.012 |
| neutral | 11 | 0.000 | 0.001 | 0.004 | 0.015 | 0.256 | 0.046 |

Bodies separate (F median 0.002 vs R median 0.603). Tails overlap in
[0.0029, 0.0651], and the overlap contains both classes:

| p | class | query | row |
| --- | --- | --- | --- |
| 0.00291 | R | machinae-combat-systems | typescript-simulation-style.md |
| 0.00348 | R | dream-plan-runs-actually | obsidian-mem-dream-run-agentoptions-fix-launchroute-failed-turn-session-log-scan.md |
| 0.00451 | F | layout-sidecar-model-cache | drupal-discovery-cache-clear.md |
| 0.00799 | R | milvus-irrelevant-context | milvus-lite-verified-bootstrap-command-and-stack-traps.md |
| 0.01059 | F | lywa-glossary-synonyms | guestwise/event-entity-label-field-name.md |
| 0.01893 | F | typecheck-test-trees | guestwise/theme-playwright-harness.md |
| 0.02130 | F | lib-tracked-build-contract | guestwise/theme-playwright-harness.md |
| 0.03017 | F | lib-tracked-build-contract | guestwise/theme-storybook-css-pipeline.md |
| 0.03077 | R | lywa-synonym-service-di | drupal/drupal11-entity-form-di.md |
| 0.03362 | R | lywa-synonym-service-di | drupal/drupal11-entity-form-di.md |
| 0.06514 | F | layout-sidecar-model-cache | drupal/drupal-index.md |
| 0.06900 | R | machinae-threejs-renderer | typescript-simulation-style.md |

# Cutoff sweep (sigmoid floor on the production page)

Cutoff drops rows with p below it; nothing refills the page. The re-sort
by p is metric-identical (metrics depend on the kept set); the artifact
carries the re-sorted pages. The task's sweep first, then the fine sweep
around the cliff:

| cutoff | returned | R | A | F | . | P@k | forbRate | recall | relMissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 63 | 18 | 21 | 13 | 11 | 0.286 | 0.206 | 0.636 | 8/22 |
| 0.20 | 22 | 12 | 8 | 0 | 2 | 0.545 | 0.000 | 0.409 | 13/22 |
| 0.25 | 17 | 12 | 4 | 0 | 1 | 0.706 | 0.000 | 0.409 | 13/22 |
| 0.30 | 15 | 12 | 3 | 0 | 0 | 0.800 | 0.000 | 0.409 | 13/22 |
| 0.35 | 15 | 12 | 3 | 0 | 0 | 0.800 | 0.000 | 0.409 | 13/22 |
| 0.40 | 13 | 10 | 3 | 0 | 0 | 0.769 | 0.000 | 0.364 | 14/22 |
| 0.50 | 10 | 9 | 1 | 0 | 0 | 0.900 | 0.000 | 0.364 | 14/22 |

| cutoff | returned | R | A | F | . | P@k | forbRate | recall | relMissed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.001 | 53 | 18 | 19 | 9 | 7 | 0.340 | 0.170 | 0.636 | 8/22 |
| 0.002 | 47 | 18 | 16 | 6 | 7 | 0.383 | 0.128 | 0.636 | 8/22 |
| 0.0025 | 45 | 18 | 15 | 6 | 6 | 0.400 | 0.133 | 0.636 | 8/22 |
| 0.0028 | 45 | 18 | 15 | 6 | 6 | 0.400 | 0.133 | 0.636 | 8/22 |
| 0.003 | 43 | 17 | 14 | 6 | 6 | 0.395 | 0.140 | 0.591 | 9/22 |
| 0.0035 | 42 | 16 | 14 | 6 | 6 | 0.381 | 0.143 | 0.545 | 10/22 |
| 0.005 | 39 | 16 | 14 | 5 | 4 | 0.410 | 0.128 | 0.545 | 10/22 |
| 0.01 | 36 | 15 | 13 | 5 | 3 | 0.417 | 0.139 | 0.500 | 11/22 |
| 0.02 | 33 | 15 | 12 | 3 | 3 | 0.455 | 0.091 | 0.500 | 11/22 |
| 0.03 | 30 | 15 | 11 | 2 | 2 | 0.500 | 0.067 | 0.500 | 11/22 |
| 0.05 | 26 | 13 | 10 | 1 | 2 | 0.500 | 0.038 | 0.455 | 12/22 |
| 0.07 | 24 | 12 | 10 | 0 | 2 | 0.500 | 0.000 | 0.409 | 13/22 |
| 0.10 | 24 | 12 | 10 | 0 | 2 | 0.500 | 0.000 | 0.409 | 13/22 |

Forbidden-rate is 0.000 only where recall has already lost 5 relevant
notes; every recall-preserving point keeps forbidden-rate >= 0.133.

# Flipped rows

Relevant (R) rows dropped, at each distinct loss step (the complete ledger
for every cutoff is in the artifact's `sweep[].flipped`):

| first cutoff dropping it | p | query | row |
| --- | --- | --- | --- |
| 0.003 | 0.00291 | machinae-combat-systems | typescript-simulation-style.md |
| 0.0035 | 0.00348 | dream-plan-runs-actually | obsidian-mem-dream-run-agentoptions-fix-launchroute-failed-turn-session-log-scan.md |
| 0.01 | 0.00799 | milvus-irrelevant-context | milvus-lite-verified-bootstrap-command-and-stack-traps.md |
| 0.04 | 0.03077 + 0.03362 | lywa-synonym-service-di | drupal/drupal11-entity-form-di.md (both chunks) |
| 0.07 | 0.06900 | machinae-threejs-renderer | typescript-simulation-style.md |
| 0.40 | 0.35738 | guestwise-ci-playwright | guestwise/ci-css-aggregation-404.md |
| 0.40 | 0.36494 | lib-tracked-build-contract | dsh-plugin-obsidian-mem-lib-is-tracked-post-clean-build-contract.md |
| 0.50 | 0.49524 | subagent-zero-recall | obsidian-mem-subagent-zero-recall-is-budget-not-gating.md |

Forbidden (F) rows dropped at the zero-loss cutoff 0.0028 (7 of 13):
`drupal/bigpipe-streams-checkout-before-drupalsettings.md` (0.00008),
`drupal/drupal-update-hook-schema-8000-baseline.md` (0.00045),
`guestwise/group-relationship-query-limitation.md` (0.00016),
`lywa/lywa-solr-pywsd-runner.md` (0.00014),
`guestwise/guestwise-demo-feature-gaps.md` (0.00106),
`npm-publish-404-not-maintainer.md` (0.00149),
`guestwise/group-config-entity-access-install.md` (0.00167).

Forbidden (F) rows that survive every cutoff below the relevant cliff
(6 of 13; killing them requires dropping the 5 R notes above):
`drupal-discovery-cache-clear.md` (0.00451),
`guestwise/event-entity-label-field-name.md` (0.01059),
`guestwise/theme-playwright-harness.md` (0.01893 and 0.02130),
`guestwise/theme-storybook-css-pipeline.md` (0.03017),
`drupal/drupal-index.md` (0.06514).

Acceptable and neutral drops at 0.0028: 6 A rows and 5 neutral rows
(A is a judgment buffer, and unlabeled neutrals are unmeasured, so these
are the honest untracked cost of even the mild gate).

# Ordering effect

Best relevant row index (1-based, cutoff none, 14 queries with a relevant
hit): baseline mean 1.286, reranked mean 1.286. The re-sort neither
promotes nor demotes the best relevant row on the post-floor page.

# Latency and disk

Measured post-warmup, wall clock, single batched tokenizer+model call per
query, pages padded to the longest member (16 of 17 queries padded to the
512-token window; that is the dominant cost driver):

| metric | value |
| --- | --- |
| first-ever load (279 MB download + session) | 41,214 ms |
| warm-cache load (session init) | 669-729 ms |
| scoring mean per query (4 runs) | 534-551 ms |
| scoring mean per row (63 rows) | 144-149 ms |
| 17-query total scoring (4 runs) | 9,085-9,363 ms |
| slowest query (6 rows x 512 pad) | 751 ms |
| model cache `models/Xenova/bge-reranker-base` | 282.7 MB, 4 files |

Latency would halve with length-sorted micro-batches or a 128-token
passage truncation (bge's own usage advice truncates passages short), but
the separability verdict does not hinge on it.

# Environment and API notes

- `TextClassificationPipeline` in transformers.js 4.3.2 applies softmax
  unless `problem_type === 'multi_label_classification'`;
  bge-reranker-base's `config.json` has no `problem_type` and one label,
  so the pipeline score is the constant 1.0. Python's pipeline applies
  sigmoid for single-logit models; transformers.js has no such branch
  (its own `// TODO: Use softmax tensor function`). Any production use
  must go through `classifier.model` + `sigmoid`, as this harness does.
- dtype `q8` resolves to the hub's `onnx/model_quantized.onnx`
  (279,301,077 bytes); the cache layout under `<dbDir>/models` mirrors the
  embedder's (`Xenova/<model-id>/`).
- Determinism: two consecutive runs diffed byte-identical artifacts;
  logits, pages, and metrics all reproduced exactly.

# Pre-existing observations (not caused by this change)

- The committed TASK-003 baseline artifact vs this live re-run: 66 vs 63
  rows, P@k 0.273 vs 0.286, forbidden-rate 0.197 vs 0.206 (corpus drift;
  flagged in scripts/eval/README.md).
- Several baseline rows sit exactly at the fused floor (0.016393):
  single-route rank-1 rows survive the 1/61 floor by equality; the
  iteration-1 live-loop note about the floor dropping rank-2 single-route
  rows (0.01613 < 1/61) is consistent with this page.
- `machinae-save-restore`'s page carries no relevant row at all (recall
  was already 0 there before any reranking; the only expected relevant
  note never entered either route).
