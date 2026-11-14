# TASK-013: live-confirmation-or-handoff

Phase D (spec Step 4). Preconditions: TASK-012 decision is PASS (or
PARTIAL with the wake-extraction fix landed). A FAIL decision instead
executes the Q3 answer (report Option 4 for go-ahead, or its approved
scope).

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
