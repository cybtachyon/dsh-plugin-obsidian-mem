# PLAN: budget-rebaseline — successful dreams must restore the global budget

Reported by the 21:35 dreaming agent: post-compaction audits kept
printing "2858 of 1500" although `drupal/drupal-index.md` is now the
slimmed 2.4 KiB note. Diagnosis: `totalRecallTokensUsed()` sums live
per-session `turnRecallTokensUsed` counters (live-only, hydrated at 0,
monotonic per record, decremented only by `disposeSession` on
`agent/disposed`); the over-budget notice itself accumulates. Nothing
rewrites history, so the audit's "compact to recover budget" remediation
is unreachable within a process and the gate locks recall until restart.

## Decisions (parent rulings)

- Successful dream completion resets every live session record's
  `turnRecallTokensUsed` to zero. Semantics become "tokens injected since
  the last successful compaction or process start". Consistent with the
  once-per-session dedupe rule, which already treats dream-rewritten notes
  as fresh-injection candidates because their fingerprints moved.
- Reset fires ONLY on the `ok` post-pass path (after `setLastDream`), never
  on failed/errored runs, never on `plan`.
- Rejected: re-baselining to a content-size estimate (overengineered);
  wording-only fix (leaves recall locked until restart after a compaction
  that already fit).
- Wording names the window in both user-visible sentences (audit
  `budget.over` line, `compactionInstruction`): same single number.

## Tasks

### TASK-001 registry reset [x]

`packages/events/src/sessions.ts`: add `resetRecallUsage(): void` to
SessionRegistry — set `turnRecallTokensUsed` to 0 on every live record;
touch nothing else (dedupe ledger, throttle state, persist: counters are
not persisted, so no write). Spec in the events session spec: totals drop
to 0; per-session `recallTokensUsed` 0; injected-sources ledger and
throttle state unchanged; no persist call triggered by the reset alone.

### TASK-002 dream wiring + wording [x]

- `packages/service/src/dream.ts`: add optional
  `onRunSucceeded?: () => void` to `DreamDeps`, called after
  `setLastDream(Date.now())` on the ok path only.
- `packages/service/src/service.ts`: widen `SessionRegistryView`
  (TASK-001 note: it is currently only `{ totalRecallTokensUsed(): number
  }`; this service-side slice of the events registry must add
  `resetRecallUsage(): void` or the wiring below will not typecheck), then
  wire `onRunSucceeded: () => this.sessionRegistryValue?.resetRecallUsage()`.
- Wording in `packages/events/src/budget.ts` `compactionInstruction` and
  `packages/service/src/audit.ts` budget.over line: name the window
  ("injected since the last successful dream or host restart").
- Tests: successful run calls the dep once; failed turn / busy / plan never
  call it; service-level: over-budget fake registry reports recovered
  totals after a successful run.

### TASK-003 tools budget wording sweep [x]

The tools renderers print the same single number with their own
sentences, and those are the sentences the dreaming agent reads from
`memory_audit` and `memory_dream` output. Name the window there too:

- `packages/tools/src/audit.ts`: the `tracker` line ("N of M tokens
  used") and the "no recall budget spent in this process yet" idle line.
- `packages/tools/src/dream.ts`: both `OVER BUDGET:` lines, the
  "Budget headroom:" line, and its idle line.
- Phrase: append "injected since the last successful dream or host
  restart" to the counted lines; idle lines become "no recall budget
  spent since the last successful dream or host restart".
- Update the render-line pins in `packages/tools/tests/audit.spec.ts`
  and `packages/tools/tests/dream.spec.ts`, and the fabricated fixture
  wording there for consistency (renderer input, not an assertion).
- Do not touch the service `audit.ts` / events `budget.ts` wording;
  TASK-002 landed it.

### TASK-004 service-side budget sentences alignment

TASK-003 flagged the same sentence family still naming no window:

- `packages/service/src/dream.ts` (~898/900/903): the plan-text
  sentences "Global memory is over budget (N of M tokens used)..." and
  "Global budget headroom: N of M tokens used, K live global notes.";
  the tools plan-fixture already assumes the windowed wording.
- `packages/service/src/audit.ts` (~861): the `budget.tracker` INFO
  "no recall budget spent in this process yet; configured budget is M
  tokens" paired with the rebaselined `budget.over` line; its pin in
  `packages/service/tests/audit.spec.ts` (~308) moves with it.
- `packages/service/src/service.ts` (~849): the doc comment
  "(nothing in this process has injected anything yet)" describing
  `measured=false`; reword to the window idiom.
- Phrase matches TASK-002/003 exactly. Update every spec pin that quotes
  these sentences.

### TASK-005 gates

`pnpm build`, `pnpm test`, coverage bar, `pnpm lint`,
`prek run --files`; tracked emit committed; tree clean.

## Verification guidelines

- AGENTS.md gates as listed; live behavior (user, next host restart): a
  successful dream flips the audit budget line and re-enables turn-start
  recall without a restart.
