# TASK-003: Think recall never injects same-session-written memories

Files: `packages/events/src/toolkit.ts`, `packages/events/tests/testkit.ts`
(only if the fake needs it), `packages/events/tests/thinkIntercept.spec.ts`,
`packages/events/tests/readIntercept.spec.ts`, `packages/events/tests/turnStart.spec.ts`.

Per the Q2 answer the exclusion is a shared filter in `toolkit.ts`:
`collectFreshSources` (the one home all three recall flows already pass
their search results through) drops every result whose `sourceKeyFor`
answers true on `registry.wasWrittenIn(sessionId, key)`. That single edit
gates the turn-start, Read, and Think flows at once; `thinkIntercept.ts`
needs no filter code of its own.

Update the `toolkit.ts` module header (the fresh-source pipeline paragraph)
and the `thinkIntercept.ts` header sentence about the once-per-session rule:
a session never receives back what it itself wrote, no matter which agent
instance of that session wrote it.

Definition of Done: a test plants a search result, runs a fake
`memory_write` tools/result for the same session, then feeds a matching
think block and asserts no injection for that source (a second, unwritten
result in the same page still injects). src+lib+spec same commit; gates green.

Depends on: TASK-001, TASK-002.
