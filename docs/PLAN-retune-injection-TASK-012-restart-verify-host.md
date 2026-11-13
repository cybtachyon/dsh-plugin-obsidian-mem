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

VERIFIED 2026-11-13 (user restarted DSH ~14:54 PT):
- `~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem/packages/
  service/lib/search.js` contains `sparseQueryText` AND
  `SPARSE_SEARCH_RADIUS = 5.0` (shipped Phase-1 code in the live profile
  bundle).
- milvus-lite relaunched fresh under the restarted host: `.memlite.json`
  pid 1066975 (27 s elapsed at check), port 36745 (previous session:
  pid 629156, port 36077).
- Budget counter reset by the restart; `memory_audit` shortly after read
  1120 of 1500 (this parent session re-injected its turn-start package
  plus think-intercept blocks). Headroom is thin: probe subagents must
  launch promptly; a suppressed probe turn-start is a budget artifact
  (TASK-010 clause (e)), handled by an immediate restart + relaunch.
- Turn-start-recall probe confirmation rides TASK-013 iteration 1.

Definition of Done: running host verified to include the strip change;
budget freshly reset.

Depends on: TASK-007 (ship-ready lib), user action.
