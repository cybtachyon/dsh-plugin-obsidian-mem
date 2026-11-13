# TASK-002: memory_write observer feeding the written ledger

Files: `packages/events/src/host.ts`, a new `packages/events/src/writeLedger.ts`,
`packages/events/src/index.ts`, `packages/events/tests/testkit.ts`, a new
`packages/events/tests/writeLedger.spec.ts` (or extend `sessions.spec.ts`).

`ToolResultMirror` gains the optional structured `value?: unknown` field
(verified against the installed `@deepseek-ai/dsh-tools` types:
`tools/result` receives `ToolExecutionSuccess` which carries `value:
JsonValue`; the "omitted from durable events" note covers durable session
events, not this emit).

New install function (plugin-ctx `tools/result`, same registration shape as
`installMemoryToolWatch`, wired in `mountLifecycle`):

- Fires only for `exec.name === TOOL_MEMORY_WRITE` (core constant),
  `!result.isError`, and a type-guarded `value.kind === 'written'`.
- Reads `value.path` (the FINAL absolute path the tool reports) and
  `value.vault`, keys them through `sourceKeyFor`, and calls
  `registry.noteWrittenSource(String(exec.agent.id), key)`.
- Never throws (runGuarded); absent `exec.agent` skips.

Definition of Done: tests cover written/other-kind refusals (rendered value
`read_required` etc. records nothing), missing agent, non-memory tools,
poisoned values, and disposer unregistration. src+lib+spec same commit;
gates green.

Depends on: TASK-001.
