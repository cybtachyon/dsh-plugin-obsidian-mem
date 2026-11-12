# TASK-041 Turn-start recall injection

Depends: TASK-040, TASK-014, TASK-045 (globalMemoryIndex). `packages/events/src/turnStart.ts`.

## Scope

- Listener: `agent/created` (register per-agent pieces on `agent.ctx` inside one
  `agent.ctx.effect()` + keep disposer keyed by agent in the plugin's own effect, per
  practices.md) then first admitted step: use `agent/pre-step` (waterfall — MUST call
  `next()` and return the decision unchanged; spread the decision) when
  `turn === 1 && step === 1` or first-seen session.
- Flow (once per session):
  0. Call `ctx.obsidianMem.ensureMemoryAccess()` (lazy default vault per Decision log);
     when it returns the one-time default-vault notice, prepend it to the injected
     context (full path included).
  1. build WorkspaceManifest from the agent cwd (`agent.session.header.cwd`).
  2. query = first user message text (payload `messages`) + `manifestQueryText()`.
  3. `ctx.obsidianMem.search(query, topK=budget-fit)`; filter `shouldInject` per source.
  4. global memory index injection: `globalMemoryIndex()` within
     budgets.globalMemoryTokens (title+description index of global-scope notes; content
     only when tiny).
  5. inject via `agent.inject()` (per-agent context channel; verify name via inspection)
     each item wrapped in `<recalled_memory source="...">`; mark injected.
  6. append guidance line: "Use memory_search for the file types, coding languages, or
     frameworks you discover in this workspace: <manifest ext/frameworks list>."
- Failure containment: any error → log + skip, never block the step.

## DoD

Tests with fake agent/ctx: single injection per session (second pre-step no-op), wrapper
exactness, budget trimming, guidance line includes discovered ext; waterfall returns next
decision intact; commit.
