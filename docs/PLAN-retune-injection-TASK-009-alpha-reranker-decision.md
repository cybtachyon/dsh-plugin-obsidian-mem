# TASK-009 alpha-reranker-decision

Undecided-1: "continuing to tune the Hybrid search alpha parameter /
Re-Ranker." Record the go/no-go with evidence.

Facts to weigh (verify current before writing):
- The production fusion is CLIENT-SIDE RRF (`fuseRrf`, k=60): a rank-only
  fusion with NO alpha parameter. Tuning an alpha means replacing RRF with
  weighted score fusion (dense-vs-sparse score scales are incomparable:
  COSINE vs negated BM25, G7), a redesign, not a knob.
- `docs/research/cross-encoder-findings.md` (TASK-012) REJECTED
  bge-reranker-base as post-fusion reranker/cutoff, with reasons.
- The existing tunable surfaces (DENSE_SEARCH_RADIUS, SPARSE_SEARCH_RADIUS,
  FUSED_SCORE_FLOOR, RRF_RANKER_K) were already swept (radius-tuning and
  stopword-strip findings).

Decision: follow the Q4 answer (default RECOMMENDED: skip; revisit only if
the Phase-3 live loop shows ranking-order errors that floors cannot fix;
record which observation would reopen it). If the user elects GO, add a
follow-on implementation task to this plan before Phase 3.

Definition of Done: decision + rationale written in this file; plan
updated with any follow-on task.

Citation caveat (TASK-006): docs/research/cross-encoder-findings.md's
committed artifact was computed when the harness imported
SPARSE_SEARCH_RADIUS=2.5; the harness now follows the shipped 5.0, so a
re-run replays a different page. Cite the committed artifact's REJECT
verdict with that staleness flagged; do not present it as replaying
today's production page.

Depends on: TASK-005 (strip-ON numbers inform whether ranking order is
the remaining problem).
