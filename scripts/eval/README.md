# Offline recall eval harness (TASK-002)

`recall-eval.mjs` replays a committed, labeled query set against the LIVE
production milvus-lite collection (`obsidian_mem`, read-only) in two
dispatch shapes, so radius/fusion tuning (TASK-004+) is decided by before/
after numbers instead of vibes. It is a tuning instrument, not a unit
test: labels carry real uncertainty (see Label honesty below).

## Read-only discipline

The only RPCs issued are `connectPromise`, `getVersion`, `count`, `search`,
and `hybridSearch`. The harness never writes, deletes, drops, createIndex,
loads, releases, or touches the server process. Port/pid come from
`/home/derek/.dsh/obsidian-mem-db/.memlite.json` (override with
`MEMLITE_JSON=/path`). The gRPC channel copies the production
keepalive-suppressed client shape from
[`packages/service/src/milvus/client.ts`](../../packages/service/src/milvus/client.ts):
lite's Python server GOAWAYs the SDK's default keepalive pings, so
`grpc.keepalive_time_ms` is pinned huge and
`grpc.keepalive_permit_without_calls` is 0.

Query vectors come from the production embedder itself:
`packages/service/lib/embedder.js` `createEmbedder()` loads standalone
(no Cordis host), and the model id (`Xenova/multilingual-e5-small`, int8/
`q8`), the `query: ` prefix, and the model cache dir
(`<dbDir>/models`) all come from the constants baked into
`packages/core/lib` — nothing is retyped here, so dense scores match what
production sends.

## Modes

- `--mode legacy-hybrid` — the pre-split production shape (the retired
  `dispatchHybrid`, since replaced by the split `dispatchRoutes` in
  [`packages/service/src/search.ts`](../../packages/service/src/search.ts)):
  one `hybridSearch` with `data[]` routes (dense COSINE `params {ef:64}`,
  sparse BM25), `RRFRanker(rrfK)`, no radii, route and page limit
  `topK * oversample`, Strong consistency, full G10 projection.
- `--mode split-rrf` — the shape production's `dispatchRoutes` ships
  today: two standalone
  `search` calls (dense COSINE with `params {ef, radius, range_filter}`,
  sparse BM25 with `params {}`), a CLIENT-SIDE sparse floor, then
  client-side RRF fusion (`fused += 1/(k+rank)`, rank from 1, merged by
  `chunk_id`, sorted fused desc then chunk_id asc). This exists because
  per-route radii inside `hybridSearch` are accepted but NOT honored by
  milvus-lite 3.2.2 — see
  [radius-tuning-findings.md §4](../../docs/research/radius-tuning-findings.md).
  The BM25 floor is client-side (`-score >= --sparse-radius`) because
  BM25 scores come back negated and best-first (findings §3).

In both modes the BM25 route receives `sparseQueryText(query)`, the
production stop-word strip (retune-injection TASK-002), imported from
`packages/service/lib/search.js` and never reimplemented here.
`--keep-stopwords` sends the RAW query on the sparse route instead: the
baseline half of the strip A/B (TASK-004/005). The choice is echoed as
`keepStopwords` in the artifact config block, and it applies to the
legacy-hybrid route-membership probes too, so those route flags stay a
faithful replay of the dispatch under test.

In `legacy-hybrid` the radius knobs are ignored (lite provably ignores
them on that path; the harness says so on stderr). `--min-score` floors
FUSED scores only, both modes — never raw BM25 (G7).

## Knobs

| Flag | Default | Applies to | Meaning |
| --- | --- | --- | --- |
| `--mode` | (required) | both | `legacy-hybrid` or `split-rrf` |
| `--dense-radius` | none | split-rrf | dense COSINE `radius`, EXCLUSIVE lower bound |
| `--dense-range` | none | split-rrf | dense `range_filter`, INCLUSIVE upper bound |
| `--sparse-radius` | none | split-rrf | client-side BM25 floor: keep `-score >= N` |
| `--keep-stopwords` | off | both | skip the production BM25 stop-word strip: the sparse route gets the raw query (A/B baseline) |
| `--rrf-k` | 60 | both | `RRFRanker(k)` in legacy, client fusion k in split |
| `--min-score` | none | both | floor on fused scores before the top-k cut |
| `--top-k` | 6 | both | page size (`SEARCH_DEFAULT_TOP_K`) |
| `--oversample` | 2 | both | each route fetches `topK * N` candidates |
| `--label` | the mode | both | artifact stem → `scripts/eval/results/NAME.json` |
| `--out` | — | both | explicit artifact path (overrides the `--label` placement) |

Defaults for `--rrf-k`/`--oversample`/ef ARE the production constants:
`recall-eval.mjs` imports `RRF_RANKER_K`, `CANDIDATE_OVERSAMPLE`, and
`DENSE_SEARCH_EF` from `packages/service/lib/search.js`, so harness
defaults track `search.ts` without restating its values. The strip helper
`sparseQueryText` comes from that same module in both harnesses.

## Usage

```
# smoke (writes scripts/eval/results/legacy-hybrid.json):
node scripts/eval/recall-eval.mjs --mode legacy-hybrid

# a split-rrf point:
node scripts/eval/recall-eval.mjs --mode split-rrf \
  --dense-radius 0.55 --dense-range 1.0 --sparse-radius 2.5 \
  --rrf-k 60 --top-k 6 --oversample 2 \
  --label split-d055-s25-k60

# commit-ready artifact at an explicit path:
node scripts/eval/recall-eval.mjs --mode legacy-hybrid --out docs/research/eval-baseline-legacy.json
```

## Metrics

Per query at `top-k`: `relevant` (R), `acceptable` (A), `forbidden` (F),
`neutral` (.), `missed` (labeled-relevant sources absent from the page),
`P@k = relevant/returned`, `forbidden-rate = forbidden/returned`,
`recall = relevantLabelHits/relevantLabels` (a multi-chunk note counts
once for recall, each row for precision). The aggregate line sums the
per-query counts across all queries (micro averages). The printed table
flags each returned row's route membership (`dense`/`sparse`/`both`;
legacy-hybrid recovers membership from two extra read-only route
probes).

`scripts/eval/results/*.json` artifacts hold the config echo, per-query
pages, route candidate scores, and metrics — no timestamps, so two runs
diff cleanly. Result blobs are gitignored by default; commit a specific
baseline deliberately with `--out` (TASK-003 does this).

## Query set and label honesty

[`queries-labels.mjs`](queries-labels.mjs) holds 17 queries: 11 harvested
from real turn-start user texts in
`~/.dsh/sessions/<slug>/<session>/session.v4.jsonl.zstd` transcripts
(first `user/message` with `source.kind == "user"`; slug/session are in
each query's `origin`) — 3 obsidian-mem, 3 machinae-game, 3 lywa, 2
guestwi.se — plus 6 hand-written in-domain obsidian-mem probes. The
harvested texts are truncated to their leading request sentence(s) and
`@`-mention sigils dropped.

Known uncertainty, by design:

- Labels are file-level `source_path` matches (plus `*` path-prefix
  families like `guestwise/*`); section-pinned labels are supported but
  unused because most notes are single-section chunks.
- `acceptable` is a judgment buffer for "topically defensible, not the
  designed answer" and is deliberately NOT counted as a hit; different
  reviewers would draw some of these lines differently. The R/F split is
  the load-bearing one for tuning decisions.
- machinae-game has NO game-specific note in the collection (verified
  with read-only `chunk_text like` queries), so its only relevant label
  is the TypeScript/simulation-style note and its forbidden families
  (drupal/guestwise/lywa) were chosen from what the legacy dispatch
  actually returned during labeling.
- `lywa-glossary-synonyms` intentionally has zero relevant labels (the
  knowledge was never memorized); its recall is `n/a` and it exists to
  measure forbidden pollution.
- Collections drift: the vault is live, so row count and chunk ids move
  between sessions. Re-verify labels against a fresh
  `chunk_id >= 0` query dump before trusting big deltas.

## Determinism

Same inputs produce the same output: lite search is stable at this corpus
size (the radius probe reproduced byte-identical results), client-side
sorts are total, the artifact has no timestamps, and each query vector is
embedded once per run.

## Cross-encoder rerank study (TASK-012)

`cross-encoder-rerank.mjs` replays the same query set through the CURRENT
production page (its own split-rrf page computation driving the constants
`search.ts` exports, imported from `packages/service/lib/search.js`:
radius, range, ef, sparse floor, RRF k, `FUSED_SCORE_FLOOR`, topK,
oversample, and the stop-word-stripped BM25 query via `sparseQueryText`
(no flag; this page always follows production)), scores every surviving
row with
`Xenova/bge-reranker-base` via `sigmoid(raw logit)`, and reports the
cutoff sweep, the per-cutoff flipped-row ledger, per-class probability
distributions, and latency. It answers only "what would a post-fusion
cross-encoder cutoff do to this page"; there are no page knobs (production
is the fixed input). The pipeline's own text-classification score is
degenerate at this model's single logit (softmax of one value is 1.0), so
the harness calls `classifier.model` directly and applies sigmoid itself.
Latency is stdout-only; the JSON artifact has no timestamps, so two runs
diff byte-identically.

```
node scripts/eval/cross-encoder-rerank.mjs                     # default sweep
node scripts/eval/cross-encoder-rerank.mjs --cutoffs none,0.0028,0.05,0.35
node scripts/eval/cross-encoder-rerank.mjs --dtype q8 --out docs/research/...
```

The model (q8, ~279 MB) downloads once into the production model cache
(`<dbDir>/models`, core's `modelCacheDir`). Verdict and tables:
[docs/research/cross-encoder-findings.md](../../docs/research/cross-encoder-findings.md).
