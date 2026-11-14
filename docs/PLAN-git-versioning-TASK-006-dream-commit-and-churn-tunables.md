# TASK-006-dream-commit-and-churn-tunables

Dream-run end-of-process commit, churn placeholder rendering for the
prepared prompt, and the launch-text git roots (the prepared
`DEFAULT_DREAM_PROMPT` is the source of truth and stays byte-identical).

1. Render `renderPromptTunables` (packages/service/src/dream.ts):
   - `{{CHURN_THRESHOLD_PERCENT}}` → `String(config.git.churnThresholdPercent)`
   - `{{CHURN_WINDOW_COMMITS}}` → `String(config.git.churnWindowCommits)`
     (resolved config from TASK-003, defaults from TASK-002 constants;
     same pattern as `{{GLOBAL_MEMORY_TOKENS}}`, the reference feeds them
     from `defaultDreamTunables` too).
   - Add a lint test mirroring the reference `dream-prompt.spec.ts`: every
     `{{...}}` token in `DEFAULT_DREAM_PROMPT` is one the renderer knows
     (no stray placeholder survives a render).
2. Closing commit: in `DreamOrchestrator.drive`, on the ok path after
   `setLastDream` and before `onRunSucceeded`, call a new `DreamDeps`
   member `commitMemory: (message: string) => Promise<Array<{ vault: string, hash: string | null }>>`
   (service wires it to the TASK-004 manager's `commitAllShared`) with
   message `obsidian-mem: dream <ISO>`; fold the hashes into the run
   summary line the way the reference reports
   `<hash|nothing to commit>; bumped N, degraded M`
   (keep the existing summary sentence, append
   `; git: <vault>=<hash7|clean> …` only when at least one vault committed).
   Commit failure logs and does not flip `ok` (the memory work landed).
   Relevancy sidecar and state.json live under the plugin dbPath (outside
   every vault), so they never join the commit; DREAMS.md sits under the
   gitignored `.obsidian-mem/` (TASK-001 ignore text) and likewise stays
   out.
3. Launch-text roots: the prompt's Step 0 tells the agent to run
   `git fetch` "in the memory root"; the launch text must say WHERE.
   Extend `DreamDeps` with `gitRoots: () => string[]` (shared vault roots
   the manager has adopted) and, when non-empty, append to `launchText` a
   short block:
   `Memory git roots (for the Pre-Sync step): <path> …`. The prompt file
   itself is not touched.
4. Module docstring: replace the "Git-churn stressors are a documented
   deviation… vaults are not necessarily git repos here" paragraph with
   the new reality (shared vaults are git repos when enabled; churn
   stressors come from git history at the tunables' window).

Known-red assignment (from TASK-001 handoff): `packages/service/tests/
dream.spec.ts` "seeds the default prompt file once and renders tunables
from config" is RED since the prepared-prompt baseline commit because
`{{CHURN_*}}` had no renderer; this task's change turns it GREEN in the
same commit (update only the spec's expectations if they still under-pin,
never the prompt constant).

Tests (`dream.spec.ts` family with the existing dream-testkit): rendered
prompt carries `50%` and `8` in the Step 4 sentence and no `{{` left;
ok-path calls `commitMemory` exactly once after the stamp; failing
`commitMemory` logs and keeps `ok: true`; `plan` never commits; launch
text carries the roots block only when gitRoots is non-empty.

Definition of Done: build + service suite green; src+lib committed
together.
