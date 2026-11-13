# TASK-006: Live restart + subagent recall test

First live end-to-end validation of the new radii.

Step 0 RESOLVED 2026-11-12 (subagent 05ff0190 verdict): delegated
subagents DO receive recall injection (every agent gets
installTurnStart/Think/Read via `agent/created`). The zero-recall anomaly
is the GLOBAL recall budget: `isOverGlobalBudget` (strictly over 1500
tokens, live records since restart/last dream) gates ONLY turn-start
recall, and the parent session burns the headroom at its first resumed
step. Think/read-intercept recalls are ungated and fire per tool use.
(Probe id 905b82c4 never existed on this host; ignore it.)

Test-loop design therefore requires ONE enabler per iteration:
- Preferred: temporarily raise `budgets.globalMemoryTokens` in the
  plugin's Cordis config for the tuning-loop window (revert in
  TASK-013), so parent and probe both recall freely; or
- Alternative: restart the host and launch the probe subagent as the
  first memory-touching session (fragile: the parent resumes first), or
  trigger a successful memory_dream to reset counters.
Verification per iteration: probe transcript contains user/message with
source.kind "plugin:obsidian-mem" and summary "obsidian-mem: turn-start
recall"; otherwise the iteration measured nothing.

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
