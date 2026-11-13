# TASK-012 restart-verify-host

Host-side packages (service/events) load at startup; the page never picks
them up. Ask the user to restart DSH (the Test Loop step 1 the request
calls for), then verify the running host carries the Phase-1 build:
- The installed profile bundle at `~/.dsh/profiles/<profile>/node_modules`
  contains `stopword` AND the rebuilt
  `dsh-plugin-obsidian-mem/packages/service/lib/search.js` exports the
  strip helper; if the profile runs from this checkout's lib, a restart is
  still required.
- A restart also RESETS the global recall budget counter (live-only sum),
  which the live loop depends on; confirm by a probe subagent that shows
  turn-start recall (see the vault note on subagent zero-recall: zero
  turn-start recall after a restart means something is wrong, not gating).

Record here: user confirmation timestamp, how the running code was
verified, budget state.

Definition of Done: running host verified to include the strip change;
budget freshly reset.

Depends on: TASK-007 (ship-ready lib), user action.
