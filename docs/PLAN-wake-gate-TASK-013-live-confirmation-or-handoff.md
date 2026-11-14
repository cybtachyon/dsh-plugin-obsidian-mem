# TASK-013: live-confirmation-or-handoff

Phase D (spec Step 4). Preconditions: TASK-012 decision is PASS (or
PARTIAL with the wake-extraction fix landed). A FAIL decision instead
executes the Q3 answer (report Option 4 for go-ahead, or its approved
scope).

## Executed preparation (2026-11-13, orchestrator)

- Bundle reinstall step: DOES NOT EXIST. The profile entry is a symlink
  to this workspace; grep checks already pass through it
  (`SPARSE_WAKE_GATE` x11, `SPARSE_SEARCH_RADIUS = 4.75`). Restart
  alone activates the new lib.
- On the post-restart continuation, per vault `.INTENTS.md` how-line:
  1. Confirm the restart happened: the GUI-port listener pid must
     differ from 1091083 (started 15:18 pre-shipping).
  2. FIRST tool call = launch the probe subagent (the restart makes
     budget headroom; probe turn-start then fires while the parent's
     post-restart turn-start alone stays under 1500). The brief is the
     PLAN-retune-injection iteration-3 constant engineering brief,
     verbatim: query id `live-probe-beaconpulse-iter3` in
     `docs/research/eval-split-strip-on-d078-s50-k60-m016129-probeiter3.json`
     (extract with node; it is the BeaconPulse machinae-game brief).
     Coding brief ONLY; NO protocol vocabulary in the first message.
  3. After its first turn completes, `send_message` the observation
     protocol: list every recalled_memory block and think-channel
     injection received before that follow-up.
  4. Verify the probe transcript (`agent/inbox/spliced` under the
     PARENT's slug bucket) actually carries the blocks before scoring
     any absence.
  5. Score: think-channel Drupal/npm collision rows must be absent;
     machinae/sim-domain rows may appear (unaffected). Record the
     observation in spec §Step 4, then the plan Finalize.

Per the Q1 answer (inline to the restart boundary, then ask the user to
restart the host and send "continue", end the turn; on the continuation
the session resumes via the goal):

- Before the restart boundary: reinstall the bundle into the `web`
  profile from this workspace (plugin_manager install_bundle with the
  user's usual install path/spec). Report what was installed. Then ask
  the user to restart DSH (host code is startup-loaded) and send
  "continue", and END the turn.
- On continuation after the restart:
  1. verify `grep -c SPARSE_WAKE_GATE ~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem/packages/service/lib/search.js`
     is non-zero;
  2. ONE live probe iteration with the restart-then-launch-first recipe
     (coding-only first message, protocol via follow-up; see the vault
     `.INTENTS.md` how-line): expected = think-channel Drupal/npm
     collision rows stop appearing at turn-start, machinae/domain rows
     unaffected;
  3. record the Step 4 section in the spec doc (grep result, probe
     observations) and commit.
- On a FAIL decision (Q3 answer): this task is replaced by the Option-4
  work proceeding automatically per the plan (snapshot first), with its
  own task files inserted after TASK-012.

Definition of Done: bundle reinstalled + restart requested at the
boundary; after continuation, grep check + live probe observations
recorded in the spec doc and committed; tree clean.
