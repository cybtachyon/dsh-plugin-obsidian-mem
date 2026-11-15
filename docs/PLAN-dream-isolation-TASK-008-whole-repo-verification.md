# TASK-008: whole-repo-verification

Phase 3: Refactor and whole-repo verification.

Run the repo gates and bring the docs to the shipped behavior.

## Steps

1. Gates: `pnpm build` (tree left clean), `pnpm test`,
   `pnpm test:coverage` (floors 85/85/78/85), `pnpm lint`,
   `prek run --files <touched paths>`. Record measured totals in this file's
   Results section.
2. Docs:
   - README.md dreaming section: one paragraph on run isolation (no recall
     injection for the dream agent and its subagents; the dream session
     carries no deployment system prompt; other sessions unaffected).
   - AGENTS.md: extend the service/events architecture bullets: the launch
     setup registers the scoped complete prompt section; the events
     `agent/created` handler claims dream lineage (prefix + parentSession)
     and skips the recall installs plus the read-intercept gate.
3. Grep sweep confirming no other injection route reads session recall
   state without the lineage gate (turnStart, thinkIntercept,
   readIntercept are the three injection homes; turnEnd watch and
   writeLedger are bookkeeping).
4. Import-extension sweep (plan header convention):
   `grep -rn "from '\.\{1,2\}/[^']*\.tsx\?'" packages/*/src` must print
   nothing. Additionally run the throwaway `tsconfig.testscheck.json`
   recipe (one per package under `packages/`, extending that package's
   tsconfig with `noEmit` and `allowImportingTsExtensions: true`,
   `include: ["tests"]`) over the events and service test trees, then
   DELETE the throwaway configs before committing.
5. Note for the docs pass: the TASK-014 "prompt constants byte-identical
   from a113305" anchor no longer holds for DEFAULT_DREAM_PROMPT (the
   TASK-001 verbiage and the user's a863357 tweaks moved it); the two
   tools-package constants remain unchanged. Do not restate the anchor.

## Definition of Done

- All gates green with measured totals recorded; docs committed; tree
  clean.

## Results (2026-11-14, final HEAD 8cc8d0d)

- `pnpm build`: exit 0; "verify-emit: 264 tsc artifacts intact across 6
  packages; 3 prompt carriers byte-exact"; `git status --porcelain`
  empty after the build.
- `pnpm test`: exit 0; 54 passed | 1 skipped files (55); 1090 passed |
  2 skipped tests (1092). No red.
- `pnpm test:coverage`: exit 0. All files: statements 94.64 / branches
  88.19 / functions 92.68 / lines 94.86 against floors 85 / 78 / 85 /
  85. No floor dragged.
- `pnpm lint`: exit 0 (eslint .).
- `prek run --files` over the four files this task touches (`README.md`,
  `AGENTS.md`, this file, `PLAN-dream-isolation.md`; no src or lib
  changed): all hooks Passed.
- Docs: README Usage gained the dreaming-run isolation paragraph (no
  recall injection for the dream session and its subagent lineage, none
  for the launcher during the run window; the dream session carries no
  deployment system prompt or session runtime context; its whole context
  is the editable `$HOME/.dsh/obsidian-mem-db/dream-prompt.md` protocol
  plus the launch-message work plan; other sessions unaffected).
  AGENTS.md service bullet gained the `dreamPromptIsolationSetup()`
  sentence (agent-scoped `complete: true` empty-text section plus
  `suppressRuntimeContext()`), and the events bullet gained the lineage
  claim at `agent/created` (`DREAM_SESSION_PREFIX` or `parentSession`
  through the registry's live-only flag), the `dreamLaunch.ts` launcher
  claim on the `started` value shape, the `toolkit.isRecallSuppressed`
  gate at its three positions, and the no-construction `dreamRunBusy()`
  seam. Per step 5, no byte-identical-from anchor restated anywhere.
- Injection-route sweep (step 3): `grep -rn "\.inject(" packages/events/src`
  answers `toolkit.ts:204` (inside `injectNotice`, the one agent-side
  `agent.inject` call), doc-comment mentions in `turnStart.ts`,
  `thinkIntercept.ts`, and `host.ts`, and `index.ts:61` `ctx.inject`
  (Cordis seam provision, not an agent injection). The three injection
  homes deliver recall only through `injectNotice`
  (`turnStart.ts:178,184,254`, `thinkIntercept.ts:332`,
  `readIntercept.ts:205`), and all three consult the gate
  (`turnStart.ts:119` before the once-per-session slot,
  `thinkIntercept.ts:269` in the scheduler above scan/sleep/budget,
  `readIntercept.ts:126` as the early return). `grep -n "inject"` over
  `turnEnd.ts`, `writeLedger.ts`, and `dreamLaunch.ts` answers nothing:
  they observe, never inject.
- Import-extension sweep (step 4):
  `grep -rn "from '\.\{1,2\}/[^']*\.tsx\?'" packages/*/src` printed
  nothing (rc 1). The throwaway `tsconfig.testscheck.json` recipe over
  the events and service test trees needed two overrides beyond the
  literal recipe (noEmit + allowImportingTsExtensions + include tests):
  `"composite": false` (the base's `composite: true` fails the
  include-tests program with TS6307) and `"rootDir": "."` (the
  package's `rootDir: src` fails it with TS6059). With those, both
  trees typecheck clean (exit 0). The inherited `incremental: true`
  scattered four `tsconfig.testscheck.tsbuildinfo` strays (package level
  plus two under `lib/`); all four strays, the two configs, and nothing
  else were deleted, and `git status --porcelain` was empty afterwards.
