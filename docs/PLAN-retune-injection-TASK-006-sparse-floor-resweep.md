# TASK-006 sparse-floor-resweep

Stripping stop words removes low-IDF terms, which shifts the negated BM25
score mass; the client-side `SPARSE_SEARCH_RADIUS = 2.5` knee may move.
Using the strip-ON harness (TASK-004), sweep `--sparse-radius` over a
reasonable grid (2.0, 2.25, 2.5, 2.75, 3.0, 3.5) at fixed dense 0.78/1.0,
k 60, and record the P@k / forbidden-rate / recall knee into
`docs/research/stopword-strip-findings.md` (append a section; keep one
home for the rule). Also re-check the `FUSED_SCORE_FLOOR = 1/(k+2)` fused
floor against the strip-ON page (the TASK-007-era sweep method: replay the
committed artifact's routeCandidates client-side).

If the knee moved, update `SPARSE_SEARCH_RADIUS` (and, only with evidence,
`FUSED_SCORE_FLOOR`) in `packages/service/src/search.ts` with a dated
evidence note naming this sweep, matching the existing constant-note style.
If the knee held, say so in the findings doc and change nothing.

Definition of Done:
- Sweep table committed in the findings doc.
- Constants updated or explicitly re-confirmed with the sweep numbers cited.

Depends on: TASK-005.
