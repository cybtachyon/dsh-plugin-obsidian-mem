# BM25 stop-word strip offline A/B (TASK-005 findings)

Stack under test: the LIVE production collection `obsidian_mem`
(`milvus_lite-3.2.2`, 206 rows at run time 2026-11-13; `dense_vector`
FloatVector dim 384 HNSW/COSINE, `sparse` SparseFloatVector filled by the
`bm25` Function from `chunk_text` through the default analyzer, no jieba).
Dispatch shape: `split-rrf` at the then-production knobs (TASK-006 later
raised the sparse floor; the constant's note and radius-tuning-findings
carry the current value) — dense COSINE radius
0.78 range_filter 1.0 ef 64, client-side BM25 floor `-score >= 2.5`, client
RRF(60), topK 6, oversample 2, no fused floor (`--min-score` unset). The A/B
lever is the single `--keep-stopwords` flag
(`scripts/eval/recall-eval.mjs`, TASK-004 parity): OFF sends the raw query
text on the BM25 route, ON sends `sparseQueryText(query)` (the shipped
`packages/service/src/search.ts` strip, eng 108 + zho 78, Han split per
codepoint). Embeddings come from the production embedder
(`Xenova/multilingual-e5-small`, q8, `query:` prefix), 17 embed calls per
run. Runs were read-only per scripts/eval/README.md. Reproduce the pair
with the knobs as shipped at run time (2026-11-13, before TASK-006 moved
the sparse floor to 5.0; the pinned commands below are what regenerate
these two byte-exact artifacts, not current-knob examples):

```
node scripts/eval/recall-eval.mjs --mode split-rrf --keep-stopwords \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 2.5 \
  --rrf-k 60 --top-k 6 --oversample 2 \
  --out docs/research/eval-split-strip-off-d078-s25-k60.json
node scripts/eval/recall-eval.mjs --mode split-rrf \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 2.5 \
  --rrf-k 60 --top-k 6 --oversample 2 \
  --out docs/research/eval-split-strip-on-d078-s25-k60.json
```

Comparability (the TASK-004 note): the two runs share one corpus state
(`rowCount` 206 echoed in both artifacts), one embedder, one knob set, and
byte-identical dense-route candidate lists for all 17 queries (verified
`JSON.stringify` equality; the dense route receives the full query in both
halves). The pair `session-transcript-probe` and `milvus-goaway-keepalive`
have 0% stopword removal, and their sparse candidate lists are identical
across the pair, double-checking harness determinism. These are the only
two artifacts to read together; the pre-strip-era baselines
(`eval-split-d078-s25-k60*.json`) carry a 196/200-row corpus and the
pre-plant label set, so they stay out of every table below.

# Decisions (feeding TASK-006)

1. **The strip ships (decided work); at production knobs it is a net
   page-quality gain, NOT the precision regression the TASK-004-era smoke
   suggested.** The headline P@k 0.216 -> 0.196 is entirely duplicate-row
   accounting: both −2 "relevant" rows are a SECOND chunk of a note that
   stays on the page (budget-reminder's `global-budget` chunk
   5749885455587312; machinae-combat's `typescript-simulation-style` chunk
   4294887176612183). Label-granularity relevant hits are identical:
   15/24 both sides. Distinct forbidden rows go 30 -> 29 (file-level),
   forbidden rows 31 -> 30. No query lost a relevant note; one query
   (lywa-lightbox-pause) lost its only forbidden row.
2. **CJK fallback is ADOPTED: leave Han runs UNSTRIPPED.** The one
   hand-written zh probe (outside the committed artifacts, §"CJK analyzer"
   below) proves the re-joined per-codepoint tokens can never match a Han
   word in the index: the default analyzer stores maximal Han runs
   (no segmentation), so split codepoints match only a Han character that
   the document text happens to isolate between non-word characters. The
   strip can only lose real-run matches and add single-char accidents.
   Code change + TASK-003 golden update are follow-ups (§"Knob follow-ups").
3. **The 2.5 sparse floor is inert on this page shape** (both halves: the
   post-floor candidate count equals the fetched-window count, 193/193 per
   pair, the only 1-candidate query being `milvus-goaway-keepalive` where
   BM25 returned only one hit at all). The strip shifts the candidate
   score distribution down (mass −15.6%, median 11.96 -> 9.84), which
   changes what any candidate floor value trims: the TASK-006 floor
   re-sweep must re-run on the strip-on distribution (§"Sparse mass").
4. **Label honesty: the live collection drifted; 6 label entries are now
   unsatisfiable** (§"Label re-verification"). Both A/B halves share the
   same unsatisfiable labels, so deltas stand; absolute recall (15/24 =
   0.625) understates achievable recall (15/22 = 0.682).

# Label re-verification (before the runs)

Fresh read-only dump: `count` + `query` with `chunk_id >= 0` projecting
`chunk_id, source_path, section_header, scope` (206 rows, 122 distinct
`source_path`), plus a `chunk_text` projection to locate Han content. The
collection grew 196 (era of `eval-split-d078-s25-k60.json`) -> 200 (era of
`-m0164.json`) -> 206 here.

All 17 queries' relevant/acceptable/forbidden labels re-resolve against the
live rows EXCEPT the four planted tuning-test notes, which are gone from
the collection:

| label (file) | role | queries | live state |
| --- | --- | --- | --- |
| `machinae-game/machinae-game-bitecs-query-registration-for-sim-tests.md` | relevant | machinae-combat-systems | archived + unindexed |
| `machinae-game/machinae-game-three-js-instanced-render-batching.md` | relevant | machinae-threejs-renderer | archived + unindexed |
| `unity-dots-entity-query-chunk-iteration.md` | forbidden | machinae-combat-systems, machinae-threejs-renderer | archived + unindexed |
| `react-three-fiber-gallery-viewer-memoization.md` | forbidden | machinae-combat-systems, machinae-threejs-renderer | archived + unindexed |

The four files still exist in the vault with `archive: true` and the body
line "Tagged tuning-test note (POS-1/POS-2/NEG-1/NEG-2; archived:
recall-tuning loop finished 2026-11-13)". The archival happened EARLIER
than queries-labels.mjs anticipated ("ARCHIVED after the live tuning loop
ends, which returns this set to its pre-plant ground truth"); the indexer
removed their rows. Recorded re-label (NOT applied to the committed label
file by this task, see "Knob follow-ups" 5): the two machinae queries
return to pre-plant ground truth (`typescript-simulation-style.md` the
only relevant source), and their planted-decoy forbidden entries are dead
labels. Consequences for the numbers here: `relevantLabels` sums to 24
with 2 unsatisfiable entries (achievable max 22); both machinae queries
show 1 missed relevant label in BOTH halves; the forbidden-rate is lower
than the planting era because the two decoys can no longer appear.

# Aggregates (micro averages, 17 queries x 6 returned)

| metric | strip OFF (keep) | strip ON | delta |
| --- | --- | --- | --- |
| returned | 102 | 102 | 0 |
| relevant rows (R) | 22 | 20 | −2 (both same-note duplicates) |
| acceptable rows (A) | 30 | 31 | +1 |
| forbidden rows (F) | 31 | 30 | −1 |
| neutral rows (.) | 19 | 21 | +2 |
| P@k | 0.216 | 0.196 | −0.020 (duplicate accounting) |
| forbidden-rate | 0.304 | 0.294 | −0.010 |
| recall-of-labeled | 15/24 = 0.625 | 15/24 = 0.625 | 0 |
| relevant label hits (distinct) | 15 | 15 | 0 |

Four of 17 pages are identical rows, order, fused scores, and route flags.
Six more return the same six rows with sub-0.001 fused-score shifts (three
reorder among them; at `layout-sidecar-model-cache`
`drupal/drupal11-plugin-discovery.md` gains sparse membership, dense ->
both, fused +0.0145). The seven that moved each swapped exactly one row
(per-query detail below); the aggregate class shift is +1A +2. −1F for the
swaps and −2R for the two duplicate drops.

# Per-query deltas

P@k and forbidden-rate at k=6; F rows / R rows / label-hits shown as
off -> on.

| query | R | A | F | P@k | forb | label hits |
| --- | --- | --- | --- | --- | --- | --- |
| milvus-irrelevant-context | 1->1 | 4->4 | 0->0 | 0.167->0.167 | 0.00->0.00 | 1/1 -> 1/1 |
| dream-plan-runs-actually | 1->1 | 2->2 | 3->3 | 0.167->0.167 | 0.50->0.50 | 1/1 -> 1/1 |
| budget-reminder-end-of-turn | 2->1 | 1->2 | 2->2 | 0.333->0.167 | 0.33->0.33 | 1/1 -> 1/1 |
| milvus-goaway-keepalive | 2->2 | 0->0 | 3->3 | 0.333->0.333 | 0.50->0.50 | 1/1 -> 1/1 |
| lib-tracked-build-contract | 2->2 | 1->1 | 2->2 | 0.333->0.333 | 0.33->0.33 | 1/1 -> 1/1 |
| typecheck-test-trees | 1->1 | 2->2 | 3->3 | 0.167->0.167 | 0.50->0.50 | 1/1 -> 1/1 |
| session-transcript-probe | 1->1 | 4->4 | 0->0 | 0.167->0.167 | 0.00->0.00 | 1/1 -> 1/1 |
| subagent-zero-recall | 2->2 | 3->3 | 1->1 | 0.333->0.333 | 0.17->0.17 | 1/1 -> 1/1 |
| layout-sidecar-model-cache | 1->1 | 1->1 | 4->4 | 0.167->0.167 | 0.67->0.67 | 1/2 -> 1/2 |
| machinae-combat-systems | 2->1 | 1->1 | 3->3 | 0.333->0.167 | 0.50->0.50 | 1/2 -> 1/2 |
| machinae-save-restore | 0->0 | 1->1 | 4->4 | 0.000->0.000 | 0.67->0.67 | 0/1 -> 0/1 |
| machinae-threejs-renderer | 1->1 | 2->2 | 3->3 | 0.167->0.167 | 0.50->0.50 | 1/2 -> 1/2 |
| lywa-synonym-service-di | 2->2 | 0->0 | 0->0 | 0.333->0.333 | 0.00->0.00 | 1/3 -> 1/3 |
| lywa-glossary-synonyms | 0->0 | 0->0 | 2->2 | 0.000->0.000 | 0.33->0.33 | n/a |
| lywa-lightbox-pause | 2->2 | 2->2 | 1->0 | 0.333->0.333 | 0.17->0.00 | 1/1 -> 1/1 |
| guestwise-ci-playwright | 2->2 | 3->3 | 0->0 | 0.333->0.333 | 0.00->0.00 | 2/3 -> 2/3 |
| guestwise-ticket-type-form | 0->0 | 3->3 | 0->0 | 0.000->0.000 | 0.00->0.00 | 0/2 -> 0/2 |

Every query with stopword removal that changed its page kept the same
label outcome. The two P@k regressions are duplicate drops:

- `budget-reminder-end-of-turn`: OFF carries
  `global-budget-...-note-size.md` twice (chunk 5140674106684452 both-route
  rank 1 + dense-only chunk 5749885455587312 at rank 6). ON drops the
  second chunk and gains `dream-run-agentoptions...` (acceptable, both
  route) plus `dsh-session-transcript-probe.md` (neutral, sparse) in place
  of the second duplicate and `dsh-session-cwd-header-gate.md` (neutral,
  sparse). Same label hit, a more diverse page.
- `machinae-combat-systems`: OFF carries `typescript-simulation-style.md`
  twice (chunks 4294887176612183 + 5459620790857034, both both-route). ON
  keeps one and adds `pnpm-dir-cwd-hijack.md` (neutral, sparse).

The five one-row swaps: dream-plan swaps F->F
(`guestwise/prek-staged-sweep-on-retry.md` -> `lywa/lywa-php-lint-tooling.md`);
typecheck swaps F->F (`drupal/kernel-test-full-site-recipe-setup.md` ->
`guestwise/group-config-entity-access-install.md`); machinae-threejs
swaps F->F (`drupal/drupal11-markup-xss-admin-tags.md` ->
`drupal/drupal11-hook-class-di.md`); lywa-glossary swaps . -> .
(`drupal/kernel-test-minted-field-schema.md` -> `api-docs-html-to-markdown.md`);
lywa-lightbox swaps F -> . (`guestwise/drush-config-export-diff-hazard.md`
-> `drupal/bigpipe-streams-checkout-before-drupalsettings.md`). Forbidden
FAMILIES keep rotating within `drupal/*`/`guestwise/*`/`lywa/*`; strip does
not introduce a new pollution source anywhere in the set.

# Sparse mass (BM25 route score distribution shift)

Per-query candidate pools (post-floor, fetched window limit 12, relevance
= `-score`); mass = sum over the pool:

| query | n | mass off -> on | Δmass | top off -> on | median off -> on |
| --- | --- | --- | --- | --- | --- |
| milvus-irrelevant-context | 12 | 75.1 -> 65.7 | −12% | 11.4 -> 11.1 | 5.4 -> 4.6 |
| dream-plan-runs-actually | 12 | 138.9 -> 108.5 | −22% | 19.2 -> 18.2 | 10.6 -> 8.0 |
| budget-reminder-end-of-turn | 12 | 161.8 -> 105.3 | −35% | 17.8 -> 15.5 | 12.1 -> 7.3 |
| milvus-goaway-keepalive | 1 | 3.2 -> 3.2 | 0% | 3.2 -> 3.2 | 3.2 -> 3.2 |
| lib-tracked-build-contract | 12 | 191.7 -> 181.4 | −5% | 43.2 -> 41.7 | 12.6 -> 11.7 |
| typecheck-test-trees | 12 | 80.4 -> 68.9 | −14% | 14.8 -> 13.6 | 5.6 -> 4.7 |
| session-transcript-probe | 12 | 165.4 -> 165.4 | 0% | 41.2 -> 41.2 | 10.1 -> 10.1 |
| subagent-zero-recall | 12 | 116.7 -> 111.8 | −4% | 19.3 -> 19.0 | 7.2 -> 7.0 |
| layout-sidecar-model-cache | 12 | 89.9 -> 74.0 | −18% | 9.4 -> 8.6 | 7.4 -> 5.3 |
| machinae-combat-systems | 12 | 196.4 -> 155.0 | −21% | 30.1 -> 27.5 | 14.6 -> 11.0 |
| machinae-save-restore | 12 | 154.4 -> 120.0 | −22% | 15.3 -> 12.7 | 12.4 -> 9.4 |
| machinae-threejs-renderer | 12 | 249.5 -> 168.6 | −32% | 37.3 -> 27.2 | 18.6 -> 11.9 |
| lywa-synonym-service-di | 12 | 188.9 -> 150.0 | −21% | 22.3 -> 20.1 | 15.4 -> 10.7 |
| lywa-glossary-synonyms | 12 | 115.3 -> 97.8 | −15% | 19.9 -> 16.9 | 8.8 -> 7.2 |
| lywa-lightbox-pause | 12 | 212.5 -> 202.9 | −5% | 47.8 -> 47.8 | 10.6 -> 9.6 |
| guestwise-ci-playwright | 12 | 253.7 -> 229.4 | −10% | 33.4 -> 31.0 | 18.7 -> 16.1 |
| guestwise-ticket-type-form | 12 | 153.7 -> 143.3 | −7% | 16.6 -> 16.1 | 12.0 -> 11.5 |
| TOTAL | 193 | 2547.4 -> 2151.1 | **−15.6%** | | |

How much BM25 mass disappeared: 396.2 relevance units over the 193-candidate
pool (−15.6%). The mass tracks the token removal rate (queries with 0%
removal, `session-transcript-probe` and `milvus-goaway-keepalive`, keep
byte-identical sparse pools; the −32%/−35% pages are the 39%/47% removal
queries `machinae-threejs-renderer` and `budget-reminder-end-of-turn`).
Token removal rates across the set: 126/391 tokens removed (32%), per
query 0%..50%, consistent with the minimal 108-entry `eng` list
(TASK-002/003 interpretation notes).

Candidate relevance quantiles (all 193 pooled candidates):

| | p10 | p25 | p50 | p75 | p90 |
| --- | --- | --- | --- | --- | --- |
| strip OFF | 6.26 | 8.72 | 11.96 | 15.97 | 21.67 |
| strip ON | 5.06 | 7.14 | 9.84 | 12.61 | 19.02 |

Candidates below the fixed knobs: 2.5 trims ZERO candidates in either half
(the floor is inert on this corpus/knob pair); at 5.0, OFF loses 8 of 193
and ON loses 19 of 193; the sub-10 band holds 67 (OFF) vs 100 (ON)
candidates. The strip shifts mass down ~2 points at the median, so any
floor value cuts proportionally deeper post-strip; TASK-006's re-sweep
cannot reuse the OFF distribution.

# CJK analyzer open question (one hand-written zh probe, ad hoc)

Question (carried from TASK-002): Han query text is split per codepoint and
re-joined with spaces so the 78 single-char `zho` entries can fire; do
those tokens match what the default analyzer produced at index time? The
corpus holds Han text in exactly two chunks (`chinese-copy-plugin-
description-grammar-rules.md`, `stopword-3-1-5-api-shape-and-zh-list-
limits.md`), verified by a read-only `chunk_text like` projection. One
hand-written probe: `智能体的共享记忆` (phrased on the plugin's own Chinese
README copy, which the first note documents). BM25 searches (limit 12,
floorless, read-only; the raw `/tmp/t005-zh-probe.json` dump of that run
was not committed):

| search text | form | hits |
| --- | --- | --- |
| `智能体的共享记忆` | raw joined (what `--keep-stopwords` sends) | 0 |
| `智 能 体 享 记 忆` | `sparseQueryText` output (的 removed) | 0 |
| `智 能 体 的 共 享 记 忆` | split, unstripped | 2 (via `的` ONLY) |
| `智` / `能` / `体` / `共` / `享` / `记` / `忆` | single codepoints | 0 (all) |
| `的` | single codepoint | 2 (both Han notes) |
| `记忆` | whole Han run | 1 (chinese-copy, rel 0.63) |
| `智能体` | whole Han run | 1 (chinese-copy, rel 0.63) |
| `的共享记忆` | the run as the note stores it | 1 (chinese-copy, rel 0.92) |
| `共享记忆` | substring of `的共享记忆`, not a stored token | 0 |

The probe is committed and re-runnable as
`docs/research/probes/zh-analyzer-probe.mjs` (TASK-008 watch item (a)):
read-only RPCs only (getVersion, count, two `chunk_text like` LOCATE
lookups, BM25 searches), pinned split forms as fixed strings plus a
`shipped-strip-out` line computed through the lib-imported
`sparseQueryText`, so it follows the shipped rule. Re-run 2026-11-13
(207-row collection) confirms the mechanism unchanged; the hit SET has
drifted exactly along the junk-hit class this section names: the
`stopword-3-1-5` note re-indexed (new chunk ids) and one of its chunks
quotes the split forms, so isolated-codepoint lookups (`记`, `忆`, `的`)
hit it while `substr-共享记忆` still answers 0 and every whole-run search
still hits both notes. Hit chunks are corpus-dependent between runs; the
mechanism (maximal Han runs stored; substring != token) is not.

Mechanism, settled: the default analyzer (enabled in `schema.ts`, no jieba)
tokenizes Han as MAXIMAL RUNS of Han codepoints on both index and query
sides; a run boundary is any non-word character (`（Agent）`, backticks,
spaces). There is no Han segmentation anywhere in the stack. Evidence:
whole-run searches hit (`记忆`, `智能体`, `的共享记忆`), every isolated
codepoint misses EXCEPT `的`, which hits only because both notes carry `的`
as a standalone run inside backticks. `共享记忆` exists as a substring but
not as a stored token, and returns nothing: substring != token.

Verdict: **the re-joined per-codepoint tokens provably cannot match Han
words in the index.** They match only a character the corpus happens to
standalone (the `的` accident: a split query collected 2 junk hits through
`的` that the raw query does not get), and conversely the strip DESTROYS
the matching shape: raw `记忆` returns 1 hit, stripped `记 忆` returns 0.
The documented fallback applies (TASK-002 note in `search.ts`: "if they
provably cannot, keep CJK text UNSTRIPPED (fail-open) and document that
`zho` only guards mixed-language noise"). This is not a live risk surfaced
by the A/B (all 17 eval queries are Latin-script, so the probe changes no
number in this doc), it is a correctness fix for CJK queries production
can receive.

The TASK-002/003 interpretation notes held: `zho` membership (日/月/年/
时/分/秒/一/等 in; 時/二/间/間 out) only mattered for the `的`-style
accident; none of it drove any per-query regression here.

# Knob follow-ups (input to TASK-006)

1. **CJK fail-open code change** (`sparseQueryText`): pass Han runs
   through unsplit/unstripped (keep `zho` removal ONLY for tokens that are
   already standalone single characters in the query text, i.e. the
   mixed-language-noise guard the `search.ts` comment documents). Requires
   TASK-003 golden updates (the split goldens pin today's provably-dead
   behavior). Highest-value correctness fix from this task.
   **SHIPPED (TASK-018, 2026-11-13):** `SPARSE_TOKEN_RUN` now captures
   `[\p{Script=Han}]+` maximal runs and a run is removed only when the
   WHOLE run is a list entry; the TASK-003 goldens are re-pinned against
   the shipped lib and the `sparseQueryText` docblock is the single home
   for the rule.
2. **Sparse floor re-sweep on strip-on scores**: `SPARSE_SEARCH_RADIUS`
   2.5 is inert on both halves (trims 0 of 193 fetched-window candidates);
   sweep candidates ≥ 4 to engage (ON trims 19/193 at 5.0 where OFF trims
   8/193). The strip-on quantile table above is the input distribution.
   Keep in mind the fetched window is limit 12 per route, so the sweep
   measures the floor's trim of the WINDOW, not of the corpus.
3. **No precision remedy is owed**: the P@k −0.020 is duplicate-row
   accounting, not lost relevance, so the smoke-signal remedy path (A2
   domain list) is NOT triggered by this A/B. If TASK-006 wants to
   continue reducing same-note duplicate rows, that is a chunk-identity
   dedup/rerank question, not a strip question.
4. **Production-page shape next time**: these runs leave `--min-score`
   unset, so pages include single-route rank-3 rows (fused 1/63) that
   production's `FUSED_SCORE_FLOOR` (1/62) would trim; the strip A/B stands
   either way, but a TASK-006 artifact with `--min-score 0.016129` would
   match shipped pages exactly.
5. **Re-label `queries-labels.mjs`** before the next artifact comparison:
   drop the four planted-note labels (archived and unindexed as of
   2026-11-13, §"Label re-verification") and restore the machinae queries
   to pre-plant ground truth, as that file's header itself promises. Not
   applied here because both A/B halves share the drifted labels (deltas
   stand) and re-labeling mid-pair would break this doc's artifacts.
6. **Watch item**: forbidden families still rotate within `drupal/*`,
   `guestwise/*`, `lywa/*` on the swaps (5 one-row swaps, 3 F->F family
   moves). The strip neither adds nor removes a pollution FAMILY at
   production knobs; family-level forbidden-rate reduction stays the
   fused-floor / TASK-006 knob territory, not a stopword-list question.

# Sparse floor re-sweep (TASK-006)

Prerequisites applied: (1) `scripts/eval/queries-labels.mjs` re-labeled
in commit 6c2ae75 (four planted tuning-test entries dropped; both
machinae queries back to pre-plant ground truth; `relevantLabels` now
22, the achievable maximum this doc previously could only quote as
15/22); (2) the sweep ran on post-TASK-018 shipped code (a763d6b
Han-maximal-run `sparseQueryText`; the lib the harness imports is that
commit's, all 17 eval queries Latin so 018 changes none of their strip
output).

Stack: LIVE read-only collection (`milvus_lite-3.2.2`, **205 rows** at
run time 2026-11-13; the §"Aggregates" pair above ran at 206, and the
2.5 point's unfloored replay in §"Fused-floor re-check" reproduces the
strip-ON aggregate 102/20/30, so the 1-row drift never entered the
candidate window). Fixed knobs, production parity: strip-ON, dense
radius 0.78 / range 1.0, ef 64, client RRF(60), topK 6, oversample 2,
and this time `--min-score 0.016129` = the shipped `FUSED_SCORE_FLOOR`
1/(k+2) (comparability note 4 above: the A/B pair ran floorless, so
pages here can run SHORT of 6 rows, which is exactly what production
returns). Lever: `--sparse-radius` grid 2.5 (incumbent), 4.0, 4.5, 5.0,
5.5. Artifacts (committed): `docs/research/eval-split-strip-on-d078-`
`s{25,40,45,50,55}-k60-m016129.json`. Reproduce one point with:

```
node scripts/eval/recall-eval.mjs --mode split-rrf \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 5.0 \
  --rrf-k 60 --min-score 0.016129 --top-k 6 --oversample 2 \
  --out docs/research/eval-split-strip-on-d078-s50-k60-m016129.json
```

Micro aggregates (17 queries; trims = fetched-window candidates the
floor removes, window total 193, 16/17 queries at the full 12-hit cap):

| radius | trims | returned | R | A | F | . | P@k | forb-rate | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2.5 | 0 (INERT) | 79 | 19 | 25 | 21 | 14 | 0.241 | 0.266 | 14/22 = 0.636 |
| 4.0 | 8 | 78 | 19 | 25 | 20 | 14 | 0.244 | 0.256 | 14/22 = 0.636 |
| 4.5 | 10 | 77 | 19 | 24 | 20 | 14 | 0.247 | 0.260 | 14/22 = 0.636 |
| 5.0 | 19 | 76 | 19 | 24 | 19 | 14 | 0.250 | 0.250 | 14/22 = 0.636 |
| 5.5 | 23 | 76 | 19 | 24 | 19 | 14 | 0.250 | 0.250 | 14/22 = 0.636 |

Only three pages move across the whole grid: `milvus-irrelevant-context`
reorders with the identical class multiset (AAARA -> AARAA at 4.0);
`typecheck-test-trees` goes RAAFF(5) -> RAAF(4) (trims one F at 4.0) ->
RAF(3) (trims one A at 4.5); `layout-sidecar-model-cache` goes RFFF(4)
-> RFF(3) (trims one F at 5.0). Every trimmed page row is F except the
one typecheck A; R stays 19 and the missed-relevant-label set is
IDENTICAL at all five points (layout-sidecar 1, machinae-save-restore 1,
lywa-synonym 2, guestwise-ci 2, guestwise-ticket 2).

**Decision: SPARSE_SEARCH_RADIUS 2.5 -> 5.0** (with a dated evidence
note on the constant in `packages/service/src/search.ts`; eval-harness
defaults and the cross-encoder harness follow the constant by import).
5.0 is the knee: it is ENGAGED (trims 19 of 193 window candidates, the
value TASK-005's "Knob follow-ups" 2 predicted), forbidden rows fall
21 -> 19 (forbidden-rate 0.266 -> 0.250) and P@k rises 0.241 -> 0.250,
while label-granularity recall does not move at 14/22. 5.5 trims
further (23/193) with zero page movement: shipping 5.5 would buy
nothing and only deepens the trim margin against future drift. 4.0/4.5
engage but recover only 1 of the 2 forbidden rows. The
"inert-but-harmless" option TASK-006 named is therefore NOT taken: an
ENGAGED value that improves forbidden-rate at zero recall cost exists,
so the inert 2.5 is retired.

Absolute recall note (14/22 vs the A/B's 15/22 achievable): the fused
floor this sweep adds for production parity trims one relevant row that
the floorless A/B pages kept. §"Fused-floor re-check" below names it and
its shape; it is NOT the sparse floor's doing (14/22 at 2.5 already).

# Fused-floor re-check (TASK-006)

Method (the TASK-007-era replay): recompute each committed artifact's
page CLIENT-SIDE from its `routeCandidates` with the harness's fusion
(`fused += 1/(k+rank)`, rank from 1, merged by `chunk_id`, sorted fused
desc then chunk_id asc, topK 6), then floor the FUSED scores at
none, 1/61..1/66. Row metadata (source_path, section_header) for EVERY
candidate chunk_id comes from read-only `query` batches against the live
collection, so floors looser than a run's own `--min-score` still
classify every candidate (0 unknown rows). Replayed on the two sweep
points that bracket the shipped change: s25 (incumbent sparse floor) and
s50 (new sparse floor). Micro aggregates:

| floor | s25 ret | R | F | P@k | forb | recall | s50 ret | R | F | P@k | forb | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 102 | 20 | 30 | 0.196 | 0.294 | 15/22 = 0.682 | 102 | 20 | 30 | 0.196 | 0.294 | 15/22 = 0.682 |
| 1/61 | 65 | 18 | 13 | 0.277 | 0.200 | 14/22 = 0.636 | 61 | 18 | 11 | 0.295 | 0.180 | 14/22 = 0.636 |
| 1/62 | 79 | 19 | 21 | 0.241 | 0.266 | 14/22 = 0.636 | 76 | 19 | 19 | 0.250 | 0.250 | 14/22 = 0.636 |
| 1/63 | 93 | 19 | 27 | 0.204 | 0.290 | 14/22 = 0.636 | 92 | 19 | 26 | 0.207 | 0.283 | 14/22 = 0.636 |
| 1/64 | 100 | 20 | 29 | 0.200 | 0.290 | 15/22 = 0.682 | 100 | 20 | 29 | 0.200 | 0.290 | 15/22 = 0.682 |
| 1/65 | 101 | 20 | 29 | 0.198 | 0.287 | 15/22 = 0.682 | 101 | 20 | 29 | 0.198 | 0.287 | 15/22 = 0.682 |
| 1/66 | 102 | 20 | 30 | 0.196 | 0.294 | 15/22 = 0.682 | 102 | 20 | 30 | 0.196 | 0.294 | 15/22 = 0.682 |

(The agreement floor 2/(k+1), the separate `READ_FALLBACK_AGREEMENT_FLOOR`
for the Read fallback leg, keeps 7 rows on s25 and 6 on s50 at 6/22 and
5/22 recall; out of scope for the hybridSearch default, consistent with
that constant's own note.)

Verdict: **FUSED_SCORE_FLOOR 1/(k+2) re-confirmed, unchanged** (dated
re-check line added to the constant's note):

- Looser: 1/63 adds ZERO label hits and +6 (s25) / +7 (s50) forbidden
  rows, the same direction TASK-007 measured. The one label a looser
  floor could recover is `guestwise/ddev-playwright-pnpm.md` on
  `guestwise-ci-playwright`, which only reaches the page as a
  single-route BM25 rank-4 row (fused 1/64): it needs 1/(k+4), not a
  one-step loosening, and 1/64 already re-admits 8-10 forbidden rows.
  No 1/(k+2)-adjacent value reaches it; that label is the fused floor's
  accepted cost, and it is the row behind this sweep's 15 -> 14
  absolute recall shift against the floorless A/B.
- Tighter: 1/61 keeps recall at 14/22 on today's pages and cuts 8
  forbidden rows, and the only relevant ROW it loses is a duplicate
  chunk of an already-recalled note (`milvus-lite-verified-bootstrap-`
  `...` second chunk, single-route dense rank 2, fused exactly 1/62);
  the label survives through that note's both-route rank-1 chunk. That
  is an artifact of THIS corpus: the TASK-007 live-loop probe caught a
  relevant note whose only shape WAS single-route rank 2, and 1/(k+1)
  re-floors that shape in a way the offline replay cannot see. Keeping
  1/(k+2) stands.
