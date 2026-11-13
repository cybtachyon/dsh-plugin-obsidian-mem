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
