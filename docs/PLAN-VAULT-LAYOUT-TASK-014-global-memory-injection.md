# TASK-014 global-memory-injection

Objective: pin-inject each shared vault's `globalFile` at session start, per
the behavior contract in [PLAN-vault-layout.md](../PLAN-vault-layout.md).

Files: `packages/service/src/service.ts` (new seam), `packages/events/src/
turnStart.ts` (+ `host.ts` seam typing if needed), service/events specs.

Steps:
1. Service: add a read-only accessor that, for every shared vault, resolves
   `<vault path>/<globalFile>` and returns `{ vaultPath, path, content }`
   when the file exists (raw text; no offset windowing; never provisions,
   never throws on missing). Read-only vaults are excluded.
2. Turn-start flow: after the provisioning-notice delivery and the
   global-budget gate (an over-budget session stays recall-starved; the
   existing compaction pointer path wins), BEFORE the search recall, inject
   each shared vault's global memory content wrapped with the standard
   recall tag helpers (source = the absolute file path).
3. Budget: cap each file at the remaining global budget using
   `approxCharsForTokens` against `budgets.globalMemoryTokens` minus
   `registry.totalRecallTokensUsed()`; skip a file when nothing remains;
   count injected tokens through `registry.addRecallTokens` like every flow.
4. Mark the injected source with `markSourceInjected` so the same session's
   search recall does not inject the file twice.
5. Once-per-session: `markTurnStartDone` already gates the flow; keep it.
6. Doc comments in the tool system-prompt section only if they contradict.

Definition of Done: events specs pin ordering (notice → budget gate → global
inject → search), budget clamp, dedup; service spec pins the accessor
(missing file, read-only vault, nested relative path like `memory/GLOBAL.md`);
`pnpm build` clean; emit committed with the change.

Depends on: TASK-008 (shared recall-tag and guard helpers settled).
