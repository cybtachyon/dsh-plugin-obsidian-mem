# Radius semantics on milvus-lite 3.2.2 + SDK 3.0.6 (TASK-001 findings)

Stack under test: `milvus_lite-3.2.2` (server `getVersion`),
`@zilliz/milvus2-sdk-node` 3.0.6, the LIVE production collection
`obsidian_mem` (192 rows at probe time; `dense_vector` FloatVector dim 384
HNSW/COSINE, `sparse` SparseFloatVector filled by the `bm25` Function from
`chunk_text`). Probe run 2026-11-12, read-only, per answer A2 (no scratch
instance). Reproduce with:

```
node docs/research/probes/radius-probe.mjs
```

The script reads `{port, pid}` from
`/home/derek/.dsh/obsidian-mem-db/.memlite.json`, uses the production
keepalive-suppressed client shape (`packages/service/src/milvus/client.ts`),
and emits one JSON line per probe event (request echo with vectors
compacted, raw response/error, surviving `{chunk_id, score}` digest).
Two full runs produced byte-identical results; the evidence below is from
the second run. Query vectors are synthetic (seeded unit vector, allowed
for semantics probing): with the synthetic vector the dense control's top
score is 0.1233, so the task's fixed radii (0.55/0.60/0.78) cut everything,
and the exact-boundary probes use the control's own returned scores.

# Decisions (ready for TASK-004)

## 1. Accepted param shapes

| Route | Shape | Verdict |
| --- | --- | --- |
| dense standalone `search` | `params: { radius: 0.78 }` (number) | accepted, applies |
| dense standalone `search` | `params: { radius: 0.78, range_filter: 1.0 }` (numbers) | accepted, applies |
| dense standalone `search` | `params: { radius: '0.78' }` (string) | accepted (server float-converts JSON strings), applies |
| sparse standalone `search` | `params: { radius: 2.5 }` (number) | accepted, applies (but see §3 for the inverted role) |
| sparse standalone `search` | `params: { radius: '2.5' }` (string) | accepted, applies |
| both, inside `hybridSearch` `data[]` route `params` | number or string | accepted, PARSED, but **has no effect on results** (see §4) |

Serialization fact: SDK 3.0.6 (`utils/Search.js buildSearchParams`)
JSON.stringifies each route's `params` into the `search_params` KeyValuePair
(one builder shared by search and hybridSearch), so a JS number reaches the
server as a JSON number and a JS string as a JSON string; lite accepts both
and float-converts them.

## 2. Dense (COSINE) boundary semantics: exclusive radius, inclusive range_filter

Survivors satisfy `radius < score <= range_filter`.

- D6: `radius` set to the control's EXACT top score 0.12332797050476074 →
  0 hits (a hit with score == radius is dropped → exclusive lower bound).
- D7: `radius = s1 - 1e-6` → exactly 1 hit survives (the boundary hit).
- D9: `radius = mid(s2,s3)` + `range_filter: 1.0` → exactly the top 2.
- D10: `radius = s2, range_filter = s1` → only s1 survives (score ==
  range_filter survives → range_filter is inclusive).
- V-probes: querying a chunk's own stored vector returns the self-similarity
  top score `0.9999999403953552` (float32 just below 1.0); `radius` set to
  that EXACT value returns 0 rows (V2), so the upper boundary hit is
  excluded there too.
- Defaults behave like the documented COSINE band (radius below all, upper
  1.0): `range_filter: 1.0` alone is a no-op (E3), `radius: -1` alone keeps
  everything (E6).
- `ef` does not interact with the cutoff at this corpus size: ef 16, 64,
  256 with the same radius return the same two survivors (E7/E8 vs D9).
- The cutoff trims the page before `limit` fills: short result pages are
  normal, no error.

## 3. Sparse (BM25) boundary semantics: inverted roles, negative scores

Returned BM25 scores in this build are NEGATIVE and ordered ascending
(best first; control top-8: -9.59, -9.26, -8.14, -6.57, -5.72, -4.77,
-4.56, -3.73). Empirically survivors satisfy `range_filter <= score <
radius`, i.e. the two params swap the roles they have on the COSINE route:

- `radius` is an EXCLUSIVE UPPER bound: radius 2.5 and radius 9999 keep
  everything (all scores are below both; S1/S3); radius == control's 2nd
  score keeps exactly the 1st (S9); radius == the top score keeps 0 (S6).
- `range_filter` is an INCLUSIVE LOWER bound: `range_filter` == 2nd score
  keeps that hit and everything above (8 rows, including one chunk outside
  the control's top-8, so the page refills within the band; S10);
  `range_filter: 5` alone keeps 0 (S4).
- Both together form the band `range_filter <= score < radius` (S11:
  lower=1st, upper=3rd → exactly hits 1 and 2).

Consequence for the plan's "sparse BM25 route: start 2.5, unbounded": a
positive 2.5 is an upper bound that lets every realistic hit pass, and
`radius: 2.5, range_filter: 100` is an empty band that drops everything
(S2). The score values are also off the assumed scale: across four query
texts every returned BM25 score was negative (worst -10.78, closest-to-zero
observed -0.71). The pattern (negated values, best-first = most negative
first, a single rare-term hit at -0.77) is consistent with the returned
score being `-relevance`, which matches the existing G7 note that BM25 raw
scores can be negative and must never be thresholded. Do NOT build the
sparse cutoff on a server-side positive radius.

Decision for TASK-004: apply the sparse cutoff CLIENT-SIDE on the returned
score (stable, unit-testable, semantics the eval harness measures directly).
If a server-side sparse floor is ever wanted, the observed equivalent of
"relevance > t" is `radius: -t` on the route, but that rests on the
negated-score inference and needs its own metric verification.

## 4. hybridSearch per-route radius: accepted but NOT honored (design-forcing)

Inside `hybridSearch` `data[]` (the exact `dispatchHybrid` shape: per-route
`anns_field`/`data`/`limit`/`metric_type`/`params`, `RRFRanker(60)`, full
G10 `output_fields`), route-level `params.radius`/`range_filter`:

- Are SENT by the SDK (same `buildSearchParams` that carries the standalone
  radius, which the server demonstrably applies).
- Are PARSED by lite: `params: { ef: 64, radius: 'not-a-number' }` on the
  dense route makes the server answer with reason
  `could not convert string to float: 'not-a-number'` (H6).
- But do NOT change the result set at all: H1 (dense radius that leaves 2
  candidates standalone, D9), H2 (both routes radii), H3 (dense radius
  9999, which under the established dense lower-bound rule leaves ZERO
  candidates, cf. E5: radius 1.5 → 0 rows), H4 and H5 (string radii)
  all returned the same 10 rows with the same chunk_ids and the same fused
  scores, in the same order, as the no-radius control H0 (see SUMMARY
  evidence).

Therefore on this stack a single `hybridSearch` call cannot carry per-route
range cutoffs. The required tuning from the plan (radius per route) needs
one of:

1. Split dispatch into two standalone `search` calls (dense with
   `radius`, sparse with a client-side cutoff per §3) and fuse client-side
   with the same RRF(k=60) formula (`score = Σ 1/(60 + rank)`; the fused
   control scores confirm lite uses 1/(k+rank) with rank starting at 1:
   0.016393 = 1/61, 0.031010 = 1/64 + 1/65), then truncate as today; or
2. Keep `hybridSearch` and tune only the post-fusion `minScore` floor
   (already exists in `search.ts`), which is NOT a per-route radius and
   changes the plan's semantics (the fused RRF score carries no route
   score, so noise from one route cannot be cut by route).

Option 1 preserves the plan's per-route semantics and is verified feasible
by the standalone probes (dense radius fully works; sparse filtering moves
client-side). Whether ef survives in hybrid route params was not at issue
here and remains unverified.

## 5. Edge and error behaviors (both routes, lite 3.2.2)

- `range_filter` without `radius`: never rejected. Dense: no-op (E3).
  Sparse: applies as an inclusive lower bound (S4, S10).
- Inverted band (`radius: 0.9, range_filter: 0.5`): accepted, 0 rows, no
  error (E4).
- Radius beyond sane bounds: dense 1.5 (> COSINE max) → accepted, 0 rows
  (E5); sparse 9999 → accepted, ALL rows (upper-bound role, S3). lite does
  not validate radius against the metric range.
- Unparseable radius (string `'not-a-number'`): the server's status is
  malformed for the SDK: `error_code: "Success"` with `code: 1` and
  `reason: "could not convert string to float: 'not-a-number'"`
  (captured at the raw gRPC layer using the SDK's own request builder).
  The SDK's result formatter then throws
  `TypeError: Cannot read properties of null (reading 'scores')` from
  inside `client.search`/`client.hybridSearch` (D12/S15/H6). Production
  `callMilvus` would surface that as an `IndexOfflineError` (fail-closed,
  never a wrong payload), but note `assertOk` ALONE would pass that status
  (`error_code === 'Success'`), so a config typo in a radius value shows up
  as a confusing offline error, not a param error.
- No-match BM25 text: 0 rows, `Success`, no error (S14).

## 6. Caveats

- The 0.55/0.60/0.78 fixed radii (D2-D5) returned 0 rows because the
  synthetic query's top score is 0.1233. They prove acceptance and
  filtering direction, not whether real e5-small query scores ever clear
  0.78; TASK-003's baseline (real embedder) must establish that
  distribution before TASK-004 picks the dense value.
- Sparse score signs/order are facts about returned values; the "-score =
  relevance" reading is an inference from four texts plus the rare-term
  probe (single exact-term hit returned as -0.77, R2).

# Raw evidence

Line format: one NDJSON line per event as emitted by the probe (`REQ` =
request echo; 384-dim vectors compacted to `{"__vector":384}`; `RES` =
status + surviving `chunk_id` (last 6 digits) + score; `ERR` = the error
the public SDK method threw). Server identity:
`{"probe":"BOOT","version":{"version":"milvus_lite-3.2.2"}}`;
schema: `{"denseField":"dense_vector","sparseField":"sparse","dim":384,"rowCount":192,"functions":[{"name":"bm25","type":"BM25","input":["chunk_text"],"output":["sparse"]}]}`.

## Controls

```
D0 dense control (params absent): scores
0.123328 0.114196 0.108948 0.106251 0.104761 0.102220 0.100311 0.099963
D1 dense params {ef:64}: identical to D0
S0 sparse control ("memory search index vault note chunk"): scores
-9.591219 -9.261842 -8.143881 -6.566871 -5.718080 -4.773017 -4.555061 -3.731081
```

## Dense fixed radii (all Success, all 0 rows: synthetic top score is 0.1233)

```
REQ {"probe":"D2-dense-radius-0.78","request":{"collection_name":"obsidian_mem","anns_field":"dense_vector","data":[{"__vector":384,"__head":[0.01842280050728968,-0.009422328032732154,0.06422518329730124,0.030928391136292855]}],"limit":8,"metric_type":"COSINE","output_fields":["chunk_id"],"consistency_level":"Strong","params":{"radius":0.78}}}
RES {"probe":"D2-dense-radius-0.78","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
REQ {"probe":"D3-dense-radius-0.78-rf-1.0","request":{...same...,"params":{"radius":0.78,"range_filter":1}}}
RES {"probe":"D3-dense-radius-0.78-rf-1.0","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
REQ {"probe":"D4-dense-radius-0.55","request":{...same...,"params":{"radius":0.55}}}
RES {"probe":"D4-dense-radius-0.55","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
REQ {"probe":"D5-dense-radius-0.60-rf-1.0","request":{...same...,"params":{"radius":0.6,"range_filter":1}}}
RES {"probe":"D5-dense-radius-0.60-rf-1.0","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
```

## Dense inclusivity (radius exclusive, range_filter inclusive)

```
REQ {"probe":"D6-dense-radius-eq-s1","request":{...same...,"params":{"radius":0.12332797050476074}}}
RES {"probe":"D6-dense-radius-eq-s1","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
REQ {"probe":"D7-dense-radius-s1-eps","request":{...same...,"params":{"radius":0.12332697050476074}}}
RES {"probe":"D7-dense-radius-s1-eps","status":{"error_code":"Success","code":0},"n":1,"digest":[{"chunk_id":"712095","score":0.12332797050476074}]}
REQ {"probe":"D8-dense-radius-s1-plus-eps","request":{...same...,"params":{"radius":0.12332897050476074}}}
RES {"probe":"D8-dense-radius-s1-plus-eps","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
REQ {"probe":"D9-dense-radius-cut-s2s3","request":{...same...,"params":{"radius":0.1115717887878418,"range_filter":1}}}
RES {"probe":"D9-dense-radius-cut-s2s3","status":{"error_code":"Success","code":0},"n":2,"digest":[{"chunk_id":"712095","score":0.12332797050476074},{"chunk_id":"840927","score":0.11419570446014404}]}
REQ {"probe":"D10-dense-radius-eq-s2-rf-s1","request":{...same...,"params":{"radius":0.11419570446014404,"range_filter":0.12332797050476074}}}
RES {"probe":"D10-dense-radius-eq-s2-rf-s1","status":{"error_code":"Success","code":0},"n":1,"digest":[{"chunk_id":"712095","score":0.12332797050476074}]}
```

D11 (`range_filter` == s1 exactly, no radius) → 8 rows: s1 itself survives
`score <= range_filter`, confirming the inclusive upper bound standalone.

## Dense self-vector max boundary (V-probes)

`V0` pulled one stored `dense_vector` out via `output_fields`, `V1` re-ran
the search with exactly that vector as query data:

```
RES {"probe":"V1-self-control","status":{"error_code":"Success","code":0},"n":4,"digest":[{"chunk_id":"712095","score":0.9999999403953552},{"chunk_id":"439358","score":0.8997270464897156},{"chunk_id":"710294","score":0.8987809419631958},{"chunk_id":"119560","score":0.8958170413970947}]}
RES {"probe":"V2-self-radius-eq-selfscore","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
RES {"probe":"V3-self-radius-1.0","status":{"error_code":"Success","code":0},"n":0,"digest":[]}
```

V2's `radius` was the exact returned self score `0.9999999403953552`
(the float32 self-similarity value, promoted to double; protobuf scores
arrive as float32, so a returned value can sit just below the theoretical
1.0 max). The hit with `score == radius` was excluded, re-confirming the
exclusive lower bound at the top of the scale; `radius: 1.0` (above every
returned score) is 0 rows as the rule predicts.

## Dense edge cases

```
E1 string radius '0.78': Success, n=0 (same as numeric; a PARSED, not ignored, string: an ignored filter would have returned 8)
E2 string radius+range_filter ('0.55','1.0'): Success, n=0
E3 range_filter 1.0 WITHOUT radius: Success, n=8 (identical to control → no-op)
E4 radius 0.9 > range_filter 0.5: Success, n=0 (no validation error)
E5 radius 1.5 (> metric max): Success, n=0
E6 radius -1: Success, n=8
E7 params {ef:16, radius:cut}: n=2 (same survivors as D9)
E8 params {ef:256, radius:cut}: n=2 (same survivors as D9)
```

## Sparse BM25 probes (radius = exclusive upper bound, range_filter = inclusive lower bound)

```
S1 params {radius:2.5}: Success, n=8 (identical to control: all scores < 2.5)
S2 params {radius:2.5, range_filter:100}: Success, n=0 (band 100 <= s < 2.5 is empty)
S3 params {radius:9999}: Success, n=8 (upper bound above everything → no-op)
S4 params {range_filter:5} (no radius): Success, n=0 (lower bound above every score)
S5 params {radius:'2.5'}: Success, n=8 (string parsed like the number)
S6 params {radius:-9.591218948364258} (== top score exactly): Success, n=0
S7 params {radius: -9.591218948364258 - 1e-6}: Success, n=0
S8 params {radius:-8.702861309051514} (mid(p2,p3)): n=2 → p1,p2
S9 params {radius:-9.261841773986816} (== 2nd score exactly): n=1 → p1 only (p2 == radius dropped → exclusive upper)
S10 params {range_filter:-9.261841773986816} (== 2nd score exactly): n=8 → p2 and above, including a 9th chunk (score -3.484497) outside the control top-8 (band refills the page; p2 == range_filter kept → inclusive lower)
S11 params {radius:-8.143880844116211, range_filter:-9.591218948364258}: n=2 → p1,p2 (p3 == radius dropped)
```

```
REQ {"probe":"S9-sparse-radius-eq-p2","request":{"collection_name":"obsidian_mem","anns_field":"sparse","data":["memory search index vault note chunk"],"limit":8,"metric_type":"BM25","output_fields":["chunk_id"],"consistency_level":"Strong","params":{"radius":-9.261841773986816}}}
RES {"probe":"S9-sparse-radius-eq-p2","status":{"error_code":"Success","code":0},"n":1,"digest":[{"chunk_id":"087959","score":-9.591218948364258}]}
REQ {"probe":"S10-sparse-rf-eq-p2","request":{...same...,"params":{"range_filter":-9.261841773986816}}}
RES {"probe":"S10-sparse-rf-eq-p2","status":{"error_code":"Success","code":0},"n":8,"digest":[{"chunk_id":"299736","score":-9.261841773986816},{"chunk_id":"278917","score":-8.143880844116211},{"chunk_id":"870945","score":-6.56687068939209},{"chunk_id":"053191","score":-5.718079566955566},{"chunk_id":"561545","score":-4.773016929626465},{"chunk_id":"913893","score":-4.555060863494873},{"chunk_id":"374845","score":-3.731081008911133},{"chunk_id":"001185","score":-3.484496593475342}]}
```

## BM25 score sign across query texts

```
S12 "react component props re-render memo": 8 hits, all negative: -10.780371 -9.297272 -8.552841 -8.526976 -7.305835 -7.031006 -6.878856 -4.867424
S13 "milvus": 3 hits: -2.155065 -1.320216 -0.705671
S14 "zzqxjvkf qlmmtbwq nonexistentterm": Success, n=0 (no error on no-match text)
R2  "GOAWAY" (term present in exactly 1 of 192 chunks, found via a read-only `chunk_text like` query): 1 hit, score -0.770076
```

## hybridSearch (dispatchHybrid shape, per-route radius)

Control H0 request (identical for all H probes except the route `params`):

```
{"collection_name":"obsidian_mem","data":[{"anns_field":"dense_vector","data":[{"__vector":384,"__head":[0.01842280050728968,-0.009422328032732154,0.06422518329730124,0.030928391136292855]}],"limit":10,"metric_type":"COSINE","params":{"ef":64}},{"anns_field":"sparse","data":["memory search index vault note chunk"],"limit":10,"metric_type":"BM25"}],"rerank":{"strategy":"rrf","params":{"k":60}},"limit":10,"output_fields":["chunk_id","source_path","section_header","scope","vault","updated_at","chunk_text"],"consistency_level":"Strong"}
```

Route param variants: H1 dense `{"ef":64,"radius":0.1115717887878418}`
(the D9 cut that standalone leaves 2 rows); H2 adds sparse
`{"radius":-8.702861309051514}`; H3 dense `{"ef":64,"radius":9999}`;
H4 sparse `{"radius":9999}`; H5 both radii as STRINGS of the same numbers.
SUMMARY evidence (from the probe's own digest):

```
{"hybridIdenticalToControl":{"H1":true,"H2":true,"H3":true,"H4":true,"H5":true,"H6":false}}
H0 ids: 2644185143870945@0.03100961446762085 4983590255712095@0.016393441706895828 6879787817087959@0.016393441706895828 1318647144299736@0.016129031777381897 7572459707840927@0.016129031777381897 1092249149278917@0.01587301678955555 3202150103086097@0.01587301678955555 8239696052716575@0.015625 8443119334053191@0.015384615398943424 3286838720561545@0.01515151560306549
H3 ids: identical to H0 (chunk_id@score, order included)
H4 ids: identical to H0
```

Cross-checks X1/X2 (standalone, same radii, same route limit 10): X1
dense ef+radius 0.1116 → 2 rows; X2 sparse radius -8.7029 → 2 rows. The
radii DO bound those exact routes when the search is standalone, so the H1
result set differing (or not) from H0 is a direct read on per-route
enforcement, and it says: not enforced. The dense route's rank-4/5 dual hit
at 0.031010 (= 1/64 + 1/65, requiring BOTH routes to contribute, since one
route alone caps at 1/61 = 0.016393) surviving H3 (dense radius 9999)
proves the dense route still contributed ranks ≥ 4 under a radius that
would leave it zero candidates on the standalone route (E5).

## Rejection text (unparseable radius)

H6 (dense route `params: {"ef":64,"radius":"not-a-number"}`) and D12/S15
(the same string on either standalone route) all make the public SDK
method throw:

```
ERR {"probe":"S15-sparse-radius-garbage","error":{"name":"TypeError","message":"Cannot read properties of null (reading 'scores')"}}
ERR {"probe":"D12-dense-radius-garbage","error":{"name":"TypeError","message":"Cannot read properties of null (reading 'scores')"}}
ERR {"probe":"H6-hybrid-garbage-param","error":{"name":"TypeError","message":"Cannot read properties of null (reading 'scores')"}}
```

The hidden server status (captured once at the gRPC layer through the
SDK's own `buildSearchRequest` + channel pool, dense-garbage and
hybrid-garbage variants identical):

```
{"error_code":"Success","reason":"could not convert string to float: 'not-a-number'","code":1,"retriable":false}
```

## Final shipped tuning (converged 2026-11-13, PLAN-milvus-tuning loop)

Constants in packages/service/src/search.ts (exported; eval harnesses
import them, commit 671b2bb):

| knob | value | basis |
| --- | --- | --- |
| dense ef | 64 | unchanged |
| dense radius / range_filter | 0.78 / 1.0 | required per task; plateau in 0.78-0.84, 0.82+ cuts relevant |
| sparse BM25 floor (client, -score) | 2.5 | required per task; guards junk pages only |
| RRF k | 60 | k 10-60 indistinguishable at this corpus size |
| fused score floor (default minScore) | 1/(k+2) | the working lever; knee of the floor sweep with planted notes in the labels |

Pipeline shape: two standalone searches + client RRF fusion (lite
ignores per-route radii inside hybridSearch, §4); fused floor applied
in hybridSearch AND the searchExactSections fallback leg (exact-file
leg floor-free); turn-start search query = first user text alone
(workspace manifest text halves machinae-subset precision when
appended, TASK-015 A/B).

Before/after aggregates (17 labeled queries, topK 6; labels updated
2026-11-13 to include planted tuning-test notes): P@k 0.216 -> 0.276,
forbidden-rate 0.294 -> 0.211, page volume 102 -> 76 returned rows,
recall-of-labeled 0.682 -> 0.667.

Rejected with measurements: rrfK change; WeightedRanker (route scores
unseparable: dense class medians 0.863/0.836/0.838); BM25 k1/b
re-index (shared-vocabulary problem, destructive); bge-reranker-base
cross-encoder (docs/research/cross-encoder-findings.md: zero-
relevant-loss cutoff 0.0028 only kills deep-tail garbage; residual
forbidden inseparable; 283 MB + ~0.5 s CPU/query).

Live loop evidence: three probe iterations on /home/derek/src/
machinae-game (15 -> 14 -> 12 injections; planted POS surfaced once
the floor admitted single-route rank-2; one planted NEG rode the
deliberate rank-2 pass). Residual noise lives in the think-intercept
trigger vocabulary and the read-intercept ext fallback: query-design
issues, not tuning constants (follow-ups in the task reports).
