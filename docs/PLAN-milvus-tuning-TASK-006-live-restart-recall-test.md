# TASK-006: Live restart + subagent recall test

First live end-to-end validation of the new radii.

Step 0 (blocking investigation, resolves the 2026-11-12 anomaly where the
machinae-game probe subagent recorded ZERO recalled_memory blocks while
parent sessions saw many): determine, from `packages/events/src` (index.ts
registration seam, sessions.ts, budget.ts gates) and the transcripts under
`~/.dsh/sessions/`, whether delegated subagent sessions receive turn-start
recall, and whether the global per-host recall budget suppressed that run.
If subagents never receive recall, the test loop observes recall in a
user-launched top-level GUI session on the machinae-game workspace
instead (ask the user to open one with the agreed task prompt), or
through the subagent's read-intercept path if that does fire. Record the
finding in the plan file before proceeding.

Scope:
1. Ask the user to restart DSH (host-side lib only activates on restart;
   the profile is a symlink, so `pnpm build` output is already in place).
   Wait for their confirmation.
2. Via the `memory_write` tool add test memories to the shared default
   vault:
   - SHOULD-RECALL: 2-3 notes written to intersect the test subagent's
     task text and the machinae-game workspace manifest (name its real
     file types/frameworks found under /home/derek/src/machinae-game),
     clearly tagged `TUNING-TEST-POS`.
   - SHOULD-NOT-RECALL: 2-3 notes with partial topical overlap (share a
     couple of words with the task but wrong subject, e.g. a different
     game/engine, similar verbs), tagged `TUNING-TEST-NEG`.
   Record their paths in the plan file.
3. Launch a subagent working a task on /home/derek/src/machinae-game
   (task per questionnaire A5), instructed to `send_message` to the parent
   once per `<recalled_memory>` block it experiences, quoting the source
   path and first line.
4. Evaluate the recall stream: POS notes recalled? NEG notes recalled?
   guestwise/lightbox noise present? Log per-source outcomes into the
   plan's Live test-loop log.
5. After evaluation, keep the test notes in place only while iterating;
   otherwise archive them per A3.

Definition of Done: plan file carries the dated iteration row
(values | POS recalled | NEG recalled | noise sources | verdict).
The test memories' disposition (kept/archived) is recorded.
