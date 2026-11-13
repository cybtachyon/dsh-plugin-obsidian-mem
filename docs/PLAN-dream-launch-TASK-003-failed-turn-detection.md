# TASK-003: failed-turn-detection

A dream turn that dies inside agent-loop (kick() contains turn errors;
`whenIdle()` still resolves) must fail the run instead of being recorded as
success. Detect it deterministically from the session log.

## Files

- `packages/service/src/dream.ts`
- `packages/service/tests/dream.spec.ts`

## Changes

1. Widen the reflection seam `DreamAgentHandle.agent` with the structural
   slice actually used (never a typed import):
   `session: { ownEvents(): readonly { type: string, data?: unknown }[] }`.
   The live agent carries `readonly session: Session`
   (`@deepseek-ai/dsh-agent` runtime-types), and `ownEvents()` returns this
   session's records.
2. After `await handle.agent.whenIdle()` (inside the try, before
   `seedDreamsDiary`/`applyDreamScoring`/`setLastDream`), scan the session's
   own events for `type === 'turn/end'` records whose
   `data.reason.kind === 'error'`; extract
   `data.reason.error.message` (fallback `'unknown error'`). On any hit
   throw a plain `Error(\`dream agent turn failed: ${message}\`)` so the
   existing `catch` path records `summary.ok = false`, rejects `done`, and —
   as today — skips the stamp and the relevancy post-pass.
3. Defensive: if the structural `session`/`ownEvents` slice is absent at
   runtime, log a warning naming the missing slice (do not silently pass).

## Tests

- Double session returns a `turn/end` with
  `reason: { kind: 'error', error: { message: 'prompt variable \"{{model}}\" has no value...' } }`
  → `done` rejects; `lastSummary.ok === false`, `error` carries the message;
  `lastDreamAt()` unchanged; no relevancy sidecar written; no diary seed.
- A clean transcript (`turn/end` reason `kind: 'end'` or similar non-error)
  still runs the post-pass and stamps exactly as before.
- Missing `session` slice: run still completes and the log warning appears.

## Definition of Done

- `pnpm vitest run packages/service/tests/dream.spec.ts` green; commit.
