# TASK-014 converge-final-values

Decide convergence from the TASK-013 ledgers and ship the final tuning
values. Rules:
- Keep a change only when the iteration shows relevant-note recall held
  AND decoy/forbidden rate moved down. A change that only moves the
  boundary between "too few relevant" and "too many irrelevant" is a wash;
  revert to the last measured value instead (the request's named risk).
- Constant edits land in `packages/service/src/search.ts` with dated
  evidence notes citing the iteration ledgers; offline artifacts under
  docs/research/ back each value where the offline proxy is meaningful.
- After any constant change: rebuild, restart verification per TASK-012
  discipline (ask the user to restart again when host code changed), then
  one confirming live iteration.
- Convergence = an iteration where all seeded relevant notes answered,
  decoys stayed out, and no pre-existing forbidden rows appeared; or the
  loop is declared at best-observed values with the remaining imperfection
  documented.

Record: the final value of every tuning constant touched by this plan
(before → after per constant) with its evidence line.

Baselines to carry (from the offline phase): label-granularity recall
ceiling at production parity is 14/22 (the fused floor trims one
single-route rank-4 label row; TASK-006), SPARSE_SEARCH_RADIUS already
decided to 5.0 by the TASK-006 sweep, FUSED_SCORE_FLOOR re-confirmed at
1/(k+2). Live-loop ledgers must not chase the 14/22-capped note.

## Convergence record (2026-11-13, best-observed-values stop)

Evidence base: iterations 1-2 (contaminated baseline), iteration 3 (clean
query hygiene), offline replays `docs/research/eval-split-strip-on-d078-s50-k60-m016129-probeiter3.json`
and the TASK-006 sweep family.

| Constant / surface | Final value | Before -> after | Evidence |
| --- | --- | --- | --- |
| sparse-query stop-word strip (`sparseQueryText`) | SHIPPED (eng+zho flat list, maximal Han runs, fail-open) | none -> shipped | Offline A/B (sparse mass -15.6%, forbidden 31->30, relevant 15/24 both halves); live iteration 3 turn-start 3/3 valid rows, 0 forbidden |
| DENSE_SEARCH_RADIUS | 0.78 | unchanged | TASK-006 re-sweep; iteration 3 shows no dense-side loss |
| DENSE_RANGE_MAX | 1.0 | unchanged | shipped |
| SPARSE_SEARCH_RADIUS | 5.0 | 2.5 -> 5.0 (TASK-006, pre-live) | Iteration 3 keeps it: turn-start forbidden 0; R2's miss is ranking, not the floor (R2 passes the floor at fused rank 16 > window 8) |
| FUSED_SCORE_FLOOR | 1/(k+2) = 0.016129 | unchanged | full-page replay: R2 fused score EQUALS the floor; lowering the floor cannot raise its rank |
| RRF_RANKER_K | 60 | unchanged | RRF math + replay: dual-route-agreement rows dominate any single-route row for every k; no k lifts R2 into the window |
| GLOBAL_MEMORY_TOKENS | 1500 | unchanged | Loop discipline instead: probe = first action after restart (iterations 2-3 fired turn-start cleanly); suppression is a measurement hazard, not a tuning target |

Documented imperfection (accept, do not chase): the R2 seed
(bitECS query-order trap) does not reach injection for the order-agnostic
probe brief: BM25 never matches it on that text and dense-route-only
fusion caps it at rank 16 of 207. Loosening any knob to lift it doubles
the forbidden rate (full-page forbRate 0.317 vs 0.136 parity). A
topic-driven `memory_search` ("bitECS query order") finds it at rank 1,
which is evidence for the deferred TASK-010 recall-instruction question;
surfaced to the user as a follow-up decision, not shipped here.

Think-channel observations (out of scope for this plan's knobs, final
report candidates): 2 of 3 iteration-3 forbidden rows arrived via the
think intercept on generic terms; wake-term lists echo previously
injected note titles (self-feeding cluster).

Definition of Done: final values table written here and mirrored at the
top of `docs/research/stopword-strip-findings.md`; confirming iteration
ledger green (or documented best-observed stop).
SATISFIED 2026-11-13: table above; iteration 3 ledger green on all
scored channels except documented R2 imperfection; mirror in findings doc.

Depends on: TASK-013 (one or more iterations).
