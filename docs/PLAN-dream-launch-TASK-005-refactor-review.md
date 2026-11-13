# TASK-005: Refactor: risk review over the plan's commits

Review the files touched by the previous 4 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

## Notes for this plan's territory

- TASK-003 carry-overs to adjudicate (parent rulings):
  - `Session.ownEvents()` is `@deprecated` in the installed
    `@deepseek-ai/dsh-session@0.2.1-alpha.3` types. The check works on the
    live host today; if a same-scope read exists that is not deprecated,
    adopt it, otherwise add a one-line comment naming the deprecation and
    the removal risk. Decide, don't leave it unrecorded.
  - Failing a run on `reason.kind === 'error'` only is the plan's
    Deterministic ruling; `aborted`/`interrupted` variants cannot arise
    here because nothing cancels a dream agent. Confirm no new call site
    introduces a cancel path; if one exists, widen the failing set.
- The precedence rule (override > config > host) must stay in exactly one
  resolver (TASK-001); the blocked message and the resolver must read the
  same resolved pair.
- The `turn/end` reason shape is parsed in one place.
- `packages/tools/src/dream.ts` and the `ui` route layer: check whether the
  grown `blockedReason` needs any wording change in their surfaces
  (tool `dream_blocked` message, 503 `dream_unavailable`) — they forward the
  reason string, so no duplication should appear.
- Keep the test doubles for `create()` a single shared builder if the file
  grows more launch assertions.

## Risk review outcome (2026-11-12)

Reviewed files: `packages/service/src/dream.ts`, `packages/service/src/service.ts` (TASK-001/002), `packages/service/src/dream.ts` again (TASK-003), `packages/client/src/format.ts` and `packages/client/src/sections/dreaming.tsx` (TASK-004), plus the touched specs.

- **Multiple Sources of Truth: resolved.** The provider/model pair-completeness predicate was spelled twice (`blockedReason` and the `drive()` launch guard). `agentLaunchOptions` became `launchRoute()`, the one resolver that returns the narrowed `{ provider, model }` pair or `null`; both readers now consume only that. `NO_AGENT_MODEL_ROUTE` was already the single shared constant and stays it. The precedence rule remains in exactly one resolver. The status-facing gate resolves without a per-run override (no run exists at status time); that asymmetry is conservative and cannot block a run the Decisions admit, because the provider is host-only so an override can never complete a pair the gate's own resolution cannot.
- **Duplicate Code: resolved.** Two `agents.create` doubles existed: `fakeGateway` in `dream.spec.ts` and `launchGateway` in `service.spec.ts` (the task-file "single shared builder" note). The builder, `GatewayRecorder`, `SessionRecord`, `CLEAN_TRANSCRIPT`, `turnEndRecord`, and `failedTurnError` now live in `packages/service/tests/dream-testkit.ts` and both specs import them; the service.spec wiring runs now answer `ownEvents` with the clean transcript, so the failed-turn check executes there too instead of hitting the missing-slice path.
- **Bloaters: waved.** `DreamOrchestrator` stays one single-flight state machine. These commits grew `drive()` by roughly 15 lines (route re-check, failed-turn scan), and each new step is a private-method or pure-helper call; splitting `drive()` would spread the load-bearing order (scan before dispose, scoring before the stamp).
- **Data Clumps: resolved.** The provider/model pair was spelled inline at four seams (`DreamAgentsGateway.create.agentOptions`, `DreamDefaultModelGateway.currentSelection`, `DreamDeps.defaultAgentOptions`, the resolver return). One exported `DreamAgentRoute` names the pair at all of them.
- **Feature Envy: waved.** `assertNoFailedTurn` is the only method that touches `agent.session` heavily and already delegates the parse to the pure `failedTurnMessage`; no method spends over half its body on another class.
- **Magic Numbers: waved (nothing new in these commits).** New code reads named constants (`NO_AGENT_MODEL_ROUTE`, `PLAN_PREVIEW_CHARS`, `TOAST_HOLD_MS`, `RELEVANCY_DECAY_SCALE`). Pre-existing, outside this commit set, left for the parent: `truncate(promptPath, 56)` in `dreaming.tsx:188` (from fce6203, TASK-051) is an inline display cap that could be a named constant.
- **Overengineering: waved.** `formatLocalDate` (one caller) is the documented locale-stable copy decision with its own spec; `DreamDefaultModelGateway` is slim but is the reflection-gateway seam type the plan's Verification Guidelines require.

## TASK-003 carry-over adjudications

- **Deprecated `ownEvents()` seam: keep and record.** The installed `@deepseek-ai/dsh-session@0.2.1-alpha.3` `Session` marks every synchronous event read `@deprecated` ("new calls are prohibited"): `eventAt`, `snapshotEvents`, and `ownEvents`. No non-deprecated same-scope event read exists (`deriveMessages()` returns derived messages only and never surfaces `turn/end`). So nothing to adopt; the `DreamAgentHandle.session` doc comment now names the deprecation, the installed version, and the removal risk: a host removal lands on the existing missing-slice warning path, never a silent pass.
- **Error-only failing set: confirmed, kept.** No call site introduced by these commits cancels, interrupts, or aborts a dream agent; `dispose()` runs in the `finally` after the scan, and no other plugin code touches the `dream-*` session. `turn/end` reason parsing lives in one place (`failedTurnMessage`), so `aborted`/`interrupted` variants stay out of the failing set per the plan's Deterministic ruling.

## Surface checks (task-file notes)

- `packages/tools/src/dream.ts`: `dream_blocked` forwards `DreamBlockedError.message` verbatim; the grown `blockedReason` needed no wording change and no duplication appeared.
- `packages/ui/src/index.ts`: the 503 `dream_unavailable` answers carry the same `blocked` string from `status().dream.blocked` or the error message; forwarding only.
- The `turn/end` reason shape is parsed in `failedTurnMessage` only; `dream-testkit.ts` is the single fixture of that shape.

Verification: `pnpm build` (verify-emit 232 artifacts), `pnpm test` (724 passed), `pnpm lint` clean, `prek run --files` on the touched paths.

## Definition of Done

- Each listed risk either resolved with a commit (message starts
  `refactor(dream):`) or explicitly waved in a comment in this file with a
  one-line reason.
