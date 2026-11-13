# TASK-012: Full-repo gate pass and live-shape confirmation

Final verification across every task in this plan:

- `pnpm build` leaves the tree clean (`git status --porcelain` empty,
  verify-emit green across all six packages).
- `pnpm test` green; `pnpm test:coverage` clears the vitest.config.ts
  thresholds (85/85/78/85).
- `pnpm lint` clean.
- `prek run --files <every changed path>` clean.
- Re-run the fallback-agreement probe against
  `docs/research/eval-split-d078-s25-k60.json` and confirm the shipped
  constant reproduces it.
- Confirm the think-intercept module headers state the four new rules
  (written-source skip, all-vault intents, sleep, sentence query) and the
  search.ts headers state the two fallback-leg rules; each rule has one doc
  home.

Definition of Done: all gates green in one final state; a short note of any
deferred observation appended here for the parent agent.

Depends on: every prior task.

## Completion notes (2026-11-13)

All gates green in the final state: build twice tree-clean (verify-emit
240 artifacts / 6 packages), 807 tests pass (2 skipped), coverage
94.11/87.31/91.98/94.35 over the 85/85/78/85 floors, `pnpm lint` clean,
`prek run --files` over all 55 plan-changed paths clean. Probe replay
against `docs/research/eval-split-d078-s25-k60.json` using the SHIPPED
`READ_FALLBACK_AGREEMENT_FLOOR` (imported from `lib/search.js`): 7 of 102
returned rows pass and all 7 equal `2/(k+1)` exactly, reproducing the
TASK-009 note. Header check: thinkIntercept's module header states the
four think rules (written-source via the toolkit.ts doc home, all-vault
intents, sleep, sentence-scoped query); search.ts states the two
fallback rules (fileTokens intersection on the request field + function
notes; agreement floor home = the constant's note). One doc inaccuracy
found and fixed in pass: the header called wakeKeywords "(top 2)"; every
matched term rides the request (THINK_SEARCH_TOP_K bounds the RESULTS).

Deferred observations (deliberately out of this plan's scope):
- The `## ` marker-header regex `/^##\s+(\S.*?)\s*$/` is written twice:
  `events/src/thinkIntercept.ts` (readRecordedIntentTerms) and
  `service/src/audit.ts` (marker sections). Cross-package; the shared
  home would be core (it owns INTENTS_FILE/isIntentMarker). Untouched by
  the Phase 1 commits, so TASK-007 left it; a future core change to the
  .INTENTS.md format must update both call sites.
- Host-side effect: all events/service changes above load at host
  startup; verifying them live needs a host restart (AGENTS.md).
