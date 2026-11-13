# TASK-006: Think search query carries only the matched sentences

Files: `packages/events/src/thinkIntercept.ts`, `packages/events/tests/thinkIntercept.spec.ts`.

Stop sending whole think blocks to `memory.search`:

- New exported pure function `intentSentencesOf(blockText, matchedTerms)`:
  split the block on newlines and sentence terminators (`.`/`!`/`?` +
  boundary), keep each sentence where any matched term passes the existing
  `termPresent` word-boundary test, join with newlines. Empty answer falls
  back to the full block (never widen to nothing).
- `runThinkRecall` queries with `intentSentencesOf(...)` capped at the
  existing `THINK_QUERY_MAX_CHARS` slice; `matched` still rides
  `wakeKeywords` unchanged.
- Reuse `termPresent` (no second boundary matcher).
- Module header's "block text (capped) as query" sentence updates to the
  matched-sentence rule.

Definition of Done: unit tests on `intentSentencesOf` (multi-sentence block,
term in one sentence only, no-match fallback, newline splitting) plus one
flow test asserting the fakeMemory received the narrowed query, not the full
block. src+lib+spec same commit; gates green.

Depends on: no code dependency; same file as TASK-003/004/005, sequence last
among the thinkIntercept edits.
