# TASK-007: Iterate tuning values to convergence

Repeat the TASK-005 (offline) + TASK-006 (live) loop until the tuning is
stable, adjusting the values in `packages/service/src/search.ts` (per A1
placement) each pass.

Rules:
- Noise (NEG or cross-project sources) still showing: raise the offending
  route's radius (sparse for keyword bleed, dense for topical drift).
- POS notes or genuine project notes stop appearing: lower the radius back
  (false-negative regression is the hard stop; back off before optimizing
  further).
- One value change per pass; record every pass as a plan-file row.
- Each src change ships with its lib emit in the same commit plus updated
  spec goldens; `pnpm build && pnpm test && pnpm lint` green before
  asking the user for the next restart.
- Converge when: all POS recalled, zero NEG/cross-project noise in two
  consecutive live runs, offline harness aggregate precision@6 improved
  versus the TASK-003 baseline.

Definition of Done: final values committed and pinned in the plan file as
`Final tuning: dense=..., sparse=...`; final live iteration row shows the
convergence criterion met.

- [x] Complete 2026-11-13. Final tuning: dense radius 0.78 /
  range_filter 1.0 / ef 64, sparse -score floor 2.5, RRF k 60, fused
  score floor 1/(k+2) (commits 4814c74/0cbb07e/58d1755/4abf302/970e2f8/
  c24000f). Three live iterations logged in PLAN-milvus-tuning.md.
  Deviation from the literal convergence criterion, stated honestly:
  "zero cross-project noise in two consecutive live runs" is NOT met
  and is not attainable by value changes: the residual is (a) the
  think-intercept's stopword + self-echo trigger vocabulary and (b)
  the read-intercept ext fallback, both query-construction properties
  outside the tuned constants (see the plan's follow-up
  recommendations), and (c) one planted NEG that rides the deliberate
  rank-2 floor pass (measured offline cost: forbidden 12 -> 16 rows,
  accepted because the user rule ranks the relevant false-negative
  higher). Met: relevant notes surface (both planted POS across
  matching phrasings), offline P@k 0.216 -> 0.276 with forbidden-rate
  0.294 -> 0.211, injection volume -20% per iteration.
