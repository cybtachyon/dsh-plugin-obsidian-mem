# TASK-018: gated-parity sparse-floor re-sweep (read-only)

Phase C2 (Q5 answer: "Gate-parity floor re-sweep first"). Precedent:
TASK-006 re-swept SPARSE_SEARCH_RADIUS 2.5->5.0 after the stop-word
strip shifted BM25 mass; the wake gate is the same class of route-shape
change, and lite 3.2.2 rescores BM25 per filtered subset (spec Step 3
finding). Production now dispatches the sparse leg ALWAYS gated
(`SPARSE_WAKE_GATE_ENABLED = true`), so the shipped floor must be tuned
for the GATED shape.

Same-session discipline (mandatory): invariant-first (wake-audit 213 /
0 empty / 0 markers / 记忆 on >=1 row; repair via
`scripts/live-reindex.mjs` if regressed), then ONE no-flag baseline run
followed back-to-back by the gated grid, all on the same corpus, all
`server.rowCount` equal.

Grid (all at production parity, split-rrf, --wake-gate, dense 0.78/1.0,
rrf-k 60, top-k 6, oversample 2, min-score 0.016129; --sparse-radius
varying): 5.0 (anchor, reproduce the committed FAIL point), 4.75, 4.5,
4.0, 3.5, 3.0. Artifacts:
`docs/research/eval-split-strip-on-d078-s{50,475,45,40,35,30}-k60-m016129-wakegate.json`
(match existing naming: s{radius*10}); baseline re-run:
`...-wakegate-baseline.json` OVERWRITE-verify equal or save a
`-r2` suffixed re-run if drifted (do not destroy the committed control;
new files only).

Recovery gate per point (vs the SAME-SESSION baseline, not the old
committed one):
1. relevant-of-labeled >= baseline (target >= 15/22);
2. forbidden rows not above baseline count AND forbidden-rate not above
   baseline rate;
3. P@k not below the gated 5.0 point's 0.377 (tolerance: >= 0.36).
Pick the highest radius meeting all three (least-noise admitting
setting). Also replay FUSED_SCORE_FLOOR variants client-side from the
winning artifact's routeCandidates (1/61, 1/62, 1/63; TASK-006 method;
do not change anything, just record whether 1/62 is still the knee).
zh: probes are floorless so radius cannot move them; still re-run the
plain zh probe once at the end as a canary (must match §Step 1.3 pin).

Commit: grid artifacts + sweep table + fused-floor replay + decision
line ("gate-parity knee at X, relevant-of-labeled Y, recovery: YES/NO")
in spec §"Step 3 A/B executed" follow-on subsection (or a new §"Gated
floor re-sweep"), via docs commit. Read-only collection access
throughout; no memory_* tools; git hygiene as usual.

Definition of Done: sweep table committed; recovery verdict YES (then
TASK-019 ships the retuned constant) or NO with the residual loss
mechanism written up (then Option 4 vs Q5-close escalates to parent).
