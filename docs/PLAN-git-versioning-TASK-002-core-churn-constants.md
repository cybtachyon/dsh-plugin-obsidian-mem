# TASK-002-core-churn-constants

Add the churn math and its default constants to core (single source of
truth for the prompt placeholders and every churn consumer).

Context:
- Reference: `/home/derek/src/dsh-plugin-engramory-ext/packages/core/src/tracking.ts`
  `churnByPath` and `churnStressors` (pure over `MemoryGitCommit[]`,
  newest-first; denominator is min(window, log length); a path touched
  twice in one commit counts once).
- Target: new `packages/core/src/churn.ts` (or fold into
  `memory-git.ts` if it reads cleaner as git-history domain; decide in
  place), exported from the barrel.

Constants (Q4 answer: 50/8, and they become the CONFIG defaults in
TASK-003; consumers read resolved config, the constants are the default
source only):
- `DEFAULT_CHURN_WINDOW_COMMITS = 8`
- `DEFAULT_CHURN_THRESHOLD_PERCENT = 50`
  (percent form because the dream prompt spells
  `{{CHURN_THRESHOLD_PERCENT}}%`; `churnStressors` keeps a fraction
  threshold parameter, and the caller passes
  `thresholdPercent / 100` via one helper so the percent to fraction
  conversion has one home.)

Definition of Done:
- `churnByPath`, `churnStressors`, both defaults exported from core barrel.
- `packages/core/tests/churn.spec.ts`: window clamping (young store),
  share math (3 of 8 = 0.375), threshold strictness (at bar is not a
  stressor), first-appearance order, multi-touch one commit.
- Build + core suite green; commit src+lib together.
