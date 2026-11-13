# TASK-006 sparse-floor-resweep

Stripping stop words removes low-IDF terms, which shifts the negated BM25
score mass. TASK-005 measured the shift: candidate pool mass -15.6%
(2547 -> 2151), relevance quantiles p10..p90 6.26/8.72/11.96/15.97/21.67
-> 5.06/7.14/9.84/12.61/19.02, and `SPARSE_SEARCH_RADIUS = 2.5` is INERT
(trims 0 of 193 window candidates in both A/B halves). The constant
currently enforces no quality gate; this sweep must find a value that
actually engages on the strip-ON distribution (start >= 4.0; at 5.0 the
off-half would trim 8, the on-half 19).

PREREQUISITES (both from TASK-005's issue list):
1. Re-label `scripts/eval/queries-labels.mjs` FIRST: remove the four
   planted tuning-test label entries (POS-1/2, NEG-1/2 machinae set; the
   notes were archived and are unindexed; the file header itself promises
   this after the live loop). Record the re-label commit in the findings
   doc so achievable recall (15/22) is explicit, and commit the re-label
   with the sweep artifacts.
2. Run the sweep AFTER TASK-018 (Han-runs-unstripped) so the sweep
   reflects the final shipped `sparseQueryText`. Latin-query pages are
   unaffected by 018, so the A/B numbers carry.

Sweep: strip-ON, fixed dense 0.78/1.0, ef 64, k 60, topK 6, oversample 2,
AND production fused-page parity `--min-score 0.016129` (= 1/(k+2),
FUSED_SCORE_FLOOR; TASK-005 noted the A/B pair ran without it and so
includes rank-3 single-route rows production trims). Grid: 2.5 (document
inertness), 4.0, 4.5, 5.0, 5.5. Record the P@k / forbidden-rate / recall
knee into `docs/research/stopword-strip-findings.md` (append a section;
keep one home for the rule). Also re-check `FUSED_SCORE_FLOOR = 1/(k+2)`
against the strip-ON page (replay the committed artifact's routeCandidates
client-side, TASK-007-era method).

If the knee moved, update `SPARSE_SEARCH_RADIUS` (and, only with evidence,
`FUSED_SCORE_FLOOR`) in `packages/service/src/search.ts` with a dated
evidence note naming this sweep, matching the existing constant-note style.
If the sweep finds no value that improves forbidden-rate without cutting
recall, record that explicitly: an honest inert-but-harmless floor beats
a gate that only drops relevant rows.

Definition of Done:
- Re-label commit + sweep table committed in the findings doc.
- Constants updated or explicitly re-confirmed with the sweep numbers cited.

Depends on: TASK-018 (final shipped code), TASK-005 (distribution data).
