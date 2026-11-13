# PLAN-retune-injection

Re-tune obsidian-mem memory injection so hybrid recall hits the most useful
memories at the right times without cluttering context. Decided work: strip
stop words from the query sent to the BM25 (sparse) route so keyword matching
focuses on high-signal nouns and verbs, using the `stopword` npm package.
Undecided work (evaluate before attempting, keep only if empirically better):
further hybrid-fusion/reranker tuning, and a post-recall memory_search
instruction line. Verification ends in the live loop: seeded relevant and
decoy memories, machinae-game subagents reporting every recall they see.

## Verification guidelines

- Every tuning change is decided by before/after numbers, not vibes:
  `scripts/eval/recall-eval.mjs` A/B on the live collection with committed
  `docs/research/eval-*.json` artifacts (P@k, forbidden-rate, recall).
- The live loop is the final gate: per iteration, record which seeded
  relevant notes were recalled and which seeded decoys were NOT.
  A tuning value ships only when relevant notes still answer and decoys stop.
- Host-side packages only change behavior after a DSH restart; never verify a
  service/events change by page reload.
- If a later tuning step makes relevant memories stop showing up, revert the
  constant to the last measured value before proceeding.
- Full gates per phase: `pnpm build`, `pnpm test`, `pnpm lint`,
  `prek run --files <paths>` before each commit.

## Open questions (answers recorded below after the questionnaire)

- Q1: Strip scope is the shared `dispatchRoutes` sparse route (covers
  `hybridSearch` and `searchExactSections`), dense route keeps the full query?
- Q2: Stopword list: `stopword`'s default English `en` only, or a custom
  domain list on top?
- Q3: Re-sweep `SPARSE_SEARCH_RADIUS` (and re-check `FUSED_SCORE_FLOOR`)
  offline after the strip, since stripping shifts BM25 score mass?
- Q4: Undecided-1 (alpha / reranker): skip, given the stack fuses with RRF
  (no alpha exists) and `docs/research/cross-encoder-findings.md` REJECTED
  the reranker? Or attempt a weighted-fusion alpha anyway?
- Q5: Undecided-2 (post-recall memory_search instruction): defer unless the
  live loop shows misses the agent could have self-served? Or implement now?
- Q6: Testbed for the live loop: `/home/derek/src/machinae-game`?

### Answers (questionnaire 2026-11-13)

- A1: Shared `dispatchRoutes` seam. Stripped text rides the BM25 route of
  BOTH `hybridSearch` and `searchExactSections`; dense/e5 keeps the full
  query.
- A2: Stop word lists: `stopword` English `en` AND Chinese `zh`. If the
  A/B exposes additional low-relevancy high-frequency terms, generate a
  custom domain list on top.
- A3: Yes. Re-sweep `SPARSE_SEARCH_RADIUS` offline after the strip; update
  the constant only on evidence (TASK-006).
- A4: Skip further fusion/reranker work (RRF has no alpha; reranker
  already REJECTED) unless the Phase-3 live loop shows ranking-order
  errors. Reopen evidence to watch for: a relevant note ranked BELOW
  decoys where floors cannot fix the order.
- A5: Defer the post-recall instruction; implement only if a live-loop
  iteration shows relevant-but-not-injected notes a tool call would have
  found.
- A6: Testbed confirmed: `/home/derek/src/machinae-game`.

## Task index

### Phase 1 - BM25 stop word stripping (decided)

 - [x] [TASK-001-install-stopword-dep](docs/PLAN-retune-injection-TASK-001-install-stopword-dep.md)
 - [x] [TASK-002-implement-bm25-stopword-strip](docs/PLAN-retune-injection-TASK-002-implement-bm25-stopword-strip.md)
 - [x] [TASK-003-strip-route-unit-tests](docs/PLAN-retune-injection-TASK-003-strip-route-unit-tests.md)
 - [x] [TASK-004-eval-harness-parity](docs/PLAN-retune-injection-TASK-004-eval-harness-parity.md)
 - [x] [TASK-005-offline-ab-eval](docs/PLAN-retune-injection-TASK-005-offline-ab-eval.md)
 - [x] [TASK-018-han-run-unstripped-fix](docs/PLAN-retune-injection-TASK-018-han-run-unstripped-fix.md)
 - [x] [TASK-006-sparse-floor-resweep](docs/PLAN-retune-injection-TASK-006-sparse-floor-resweep.md)
 - [x] [TASK-007-green-gates](docs/PLAN-retune-injection-TASK-007-green-gates.md)
 - [x] [TASK-008-refactor-phase-1](docs/PLAN-retune-injection-TASK-008-refactor-phase-1.md)

### Phase 2 - Undecided-item decisions

 - [x] [TASK-009-alpha-reranker-decision](docs/PLAN-retune-injection-TASK-009-alpha-reranker-decision.md)
 - [ ] [TASK-010-recall-instruction-decision](docs/PLAN-retune-injection-TASK-010-recall-instruction-decision.md)

### Phase 3 - Live test loop

 - [ ] [TASK-011-seed-test-memories](docs/PLAN-retune-injection-TASK-011-seed-test-memories.md)
 - [ ] [TASK-012-restart-verify-host](docs/PLAN-retune-injection-TASK-012-restart-verify-host.md)
 - [ ] [TASK-013-live-loop-iteration](docs/PLAN-retune-injection-TASK-013-live-loop-iteration.md)
 - [ ] [TASK-014-converge-final-values](docs/PLAN-retune-injection-TASK-014-converge-final-values.md)
 - [ ] [TASK-015-refactor-phase-3](docs/PLAN-retune-injection-TASK-015-refactor-phase-3.md)

### Phase 4 - Finalization

 - [ ] [TASK-016-retire-test-debris](docs/PLAN-retune-injection-TASK-016-retire-test-debris.md)
 - [ ] [TASK-017-final-report](docs/PLAN-retune-injection-TASK-017-final-report.md)

## Dependencies

- 001 → 002 → 003 → 004 → 005 → 018 → 006 → 007 → 008 (018 inserted
  2026-11-13 from the TASK-005 zh-probe verdict: Han runs unstripped).
- 009, 010: after 005 (need the stripped-run numbers); both feed 013.
- 011: after 006 (seeding guard: unlabeled seeded rows would contaminate
  the offline P@k/forbidden baselines); feeds 013.
- 012: after 007 (ship-ready lib) and needs the user to restart DSH.
- 013: needs 011, 012, and the 009/010 decisions; may loop 011–013.
- 014: after 013 converges; feeds 015, 016, 017.
- 016, 017: after 014 (and 015).
