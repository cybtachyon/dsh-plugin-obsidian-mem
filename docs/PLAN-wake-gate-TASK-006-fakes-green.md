# TASK-006: fakes-green

Phase B (spec Step 2.2). Update test fakes so the gate cannot silently
starve them (TASK-006 lesson: a stub score silently sat under the new
floor).

1. Run `pnpm test`. Every failure caused by the new sparse-side gate
   clause is a fake problem, not a production problem (unit-level gate
   semantics are covered by TASK-004/005).
2. Audit `packages/service/tests/service.spec.ts` and any other spec
   with a fake `SearchMilvus`/BM25 stub: where a fake filters rows by
   the request `expr` or asserts the exact `expr`, either give stub BM25
   rows plausible `wake_keywords` arrays (realistic lower-cased keyword
   lists matching the fixture query vocabulary) or update the golden
   expr to carry the merged gate clause. Prefer making fixtures
   realistic (wake_keywords arrays) AND goldens exact.
3. Keep the fakes' dense-path behavior untouched.

Definition of Done: full `pnpm test` green with `SPARSE_WAKE_GATE_ENABLED
=== true`; no separate commit (lands in TASK-008).
