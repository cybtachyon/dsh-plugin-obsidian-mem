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
