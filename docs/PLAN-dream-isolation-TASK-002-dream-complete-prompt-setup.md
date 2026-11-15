# TASK-002: dream-complete-prompt-setup

Phase 1: Launch-side isolation (service).

Give the dream agent launch a creation-time scoped world that carries no
deployment system prompt and no optional runtime context, so the only
session context is the launch text (dream-prompt.md + work plan).

Mechanism (verified against installed 0.2.1-alpha.3 types):
`CreateAgentOptions.setup?: (agentCtx, agent) => ...` composes the agent's
scoped world before publication; "everything registered through `agentCtx`
(scoped tools, prompt sections/variables, ...) exists before the first
prompt assembly". `SystemPrompt.section()` registered from the agent's
context lands in the agent's scope; `PromptSection.complete: true` makes
assembly restore that exact section as the sole prompt section.
`SystemPrompt.suppressRuntimeContext()` removes the optional dynamic
runtime-context contributions in the calling context's scope.

## Steps

1. In `packages/service/src/dream.ts`:
   - Extend `DreamAgentsGateway.create`'s options with a structural
     `setup?: (agentCtx: DreamAgentPromptScope) => void` (never a typed
     agents import; mirror the local structural-type canon).
   - Add a local mirror `DreamAgentPromptScope` with
     `systemPrompt?: { section(o: { name, order, interpolate?, complete?, text }): unknown; suppressRuntimeContext?(): unknown }`.
   - Add an exported factory (name it around `dreamPromptIsolationSetup`)
     that returns the setup callback registering
     `{ name: 'obsidian-mem:dream-prompt-complete', order: 0, interpolate: false, complete: true, text: '' }`
     and calling `suppressRuntimeContext?.()` when the seam answers it.
     Doc comment states why: the dream session must receive no deployment
     persona, tool guidance, or session runtime context; its whole context
     is the launch text.
   - Pass `setup: dreamPromptIsolationSetup()` in the `gateway.create` call
     inside `drive()`.
2. `packages/service/tests/dream.spec.ts`:
   - The exact-equality `recorder.created` expectations gain the new
     `setup` key (use `expect.any(Function)` or record + assert separately).
   - New spec: call the captured `setup` with a fake agentCtx recording
     `section`/`suppressRuntimeContext` calls; assert the section options
     (`complete: true`, empty text, interpolate false) and that the
     suppressor runs when present and is skipped when absent.
   - New spec: a gateway whose create omits/never calls `setup` still runs
     (the option is additive).

## Definition of Done

- `pnpm build` + `pnpm test` green (dream suite includes the new specs).
- No import of dsh packages in service; mirrors only.
- Carrier lib emit rebuilt and committed with the src change.
