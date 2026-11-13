# PLAN-mem-loop-tuning: optimize the think / read / search memory loop

Objective: cut recall noise in the two live intercepts. Think side: never
re-inject memories this session wrote; take the intent vocabulary from every
vault's `.INTENTS.md` intent words only (never prose tokens); sleep one think
block after a successful injection; search only the sentences that carry a
matched intent/wake word. Read side: the `searchExactSections` fallback leg
must intersect chunk `wake_keywords` with file-derived tokens and require
both-route agreement, exclusively for that leg.

## Verification guidelines

Repo gates run per AGENTS.md ("Testing Instructions") after every task:
`pnpm build` (src+lib in the SAME commit), `pnpm test`, `pnpm test:coverage`
against the vitest.config.ts thresholds, `pnpm lint`, and
`prek run --files <paths>` before each commit.

Feature-specific verification:

- Every new or changed Milvus filter clause is golden-tested as a literal
  expression in `packages/service/tests/search.spec.ts` (existing pattern).
- New tuning constants are EXPORTED from `search.ts` and imported (never
  restated) by `scripts/eval/*` where a harness replays the page.
- Think-intercept behaviors are driven through the existing `testkit.ts`
  fake seams (fakeMemory, frame injection), one describe block per behavior.
- The floor-rule doc home stays exactly one: `FUSED_SCORE_FLOOR` owns the
  hybridSearch rule; the new fallback-leg constant owns the fallback rule;
  every other mention cross-references by name.
- A probe against the shipped `eval-split-d078-s25-k60.json` artifact confirms
  the fallback-agreement floor's row-count semantics matches the decision
  below before it ships.

## Open questions (asked in the questionnaire)

- Q1 Intents vocabulary: which tokens in a `.INTENTS.md` count as "intent
  words"? (marker section headers only vs. also single-word bullet entries)
- Q2 Written-source exclusion scope: Think intercept only, or all three
  recall channels (turn-start, Read, Think)?
- Q3 Both-route agreement: the literal `2/(k+1)` fused floor (which passes
  only hits ranked 1 on BOTH routes), or a route-presence agreement (chunk
  appears in both route lists at any rank)?
- Q4 Written-ledger interpretation: "the same session" = the session id
  (`agent.id`; a subagent is a separate session and may still recall the
  parent's writes), and "written" = a successful `memory_write` tool call.
  Confirm.

## Questionnaire answers (2026-11-13)

- Q1: Marker section headers only. `## <marker>` section names (canonical
  markers, `isIntentMarker`) are the intent words; bullet prose, paths, and
  every other token contribute nothing.
- Q2: All three channels via one shared filter. The written-source
  exclusion runs through `toolkit.ts` in the turn-start, Read, and Think
  flows alike.
- Q3: Literal floor 2/(k+1). Inclusive fused floor
  `2 / (RRF_RANKER_K + 1)` on the fallback leg; passes only hits ranked 1 on
  both routes (replays the old table's 7-row outcome). No route-presence
  tagging in `fuseRrf`.
- Q4: Confirmed. Same-session keyed by session id (`agent.id`); subagents
  keep their own ledgers. "Written" = a successful `memory_write` tool call.

## Micro-tasks

Dependencies: TASK-002 and TASK-003 depend on TASK-001. TASK-003..006 are
independent of each other after their prerequisites. Phase 2 tasks depend on
the Q3 answer; TASK-008 depends on TASK-007 (same leg, same file);
TASK-009 feeds the tokens TASK-007 consumes. TASK-011/012 review the tasks
each follows. TASK-013 runs after everything is checked.

### Phase 1: Think fixes (packages/events)

 - [x] [TASK-001-written-source-ledger](docs/PLAN-mem-loop-tuning-TASK-001-written-source-ledger.md)
 - [x] [TASK-002-write-observer](docs/PLAN-mem-loop-tuning-TASK-002-write-observer.md)
 - [x] [TASK-003-think-written-filter](docs/PLAN-mem-loop-tuning-TASK-003-think-written-filter.md)
 - [x] [TASK-004-intents-all-vaults](docs/PLAN-mem-loop-tuning-TASK-004-intents-all-vaults.md)
 - [x] [TASK-005-think-sleep-after-injection](docs/PLAN-mem-loop-tuning-TASK-005-think-sleep-after-injection.md)
 - [ ] [TASK-006-think-query-sentences](docs/PLAN-mem-loop-tuning-TASK-006-think-query-sentences.md)
 - [ ] [Refactor review after Phase 1](docs/PLAN-mem-loop-tuning-TASK-007-refactor-phase1.md)

### Phase 2: Read fixes (packages/service, packages/events)

 - [ ] [TASK-008-fallback-keyword-intersection](docs/PLAN-mem-loop-tuning-TASK-008-fallback-keyword-intersection.md)
 - [ ] [TASK-009-fallback-agreement-floor](docs/PLAN-mem-loop-tuning-TASK-009-fallback-agreement-floor.md)
 - [ ] [TASK-010-read-intercept-file-tokens](docs/PLAN-mem-loop-tuning-TASK-010-read-intercept-file-tokens.md)
 - [ ] [Refactor review after Phase 2](docs/PLAN-mem-loop-tuning-TASK-011-refactor-phase2.md)

### Phase 3: Gates

 - [ ] [TASK-012-verify-gates](docs/PLAN-mem-loop-tuning-TASK-012-verify-gates.md)
