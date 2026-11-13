# TASK-013 live-loop-iteration

One live-loop iteration, repeated until convergence (record each
iteration's ledger in the table below or a sibling notes file referenced
here):

1. Seed per TASK-011 (fresh iteration notes if the previous set burned).
2. Launch a `subagent` whose task is real, small work in
   `/home/derek/src/machinae-game` (pick a task matching the seeded
   relevant notes; e.g. a small simulation/entity change). Instructions:
   "For EVERY <recalled_memory> block you receive (turn-start, think, or
   read intercept), immediately `send_message` your parent with: the
   source path, which intercept delivered it, and whether it is useful,
   unrelated, or a near-miss for your task. Do not otherwise deviate from
   the coding task."
3. Collect the reports; also read the subagent's session transcript
   (`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`, per the vault
   probe note) to catch injections the subagent failed to report.
4. Ledger per note: seeded-relevant recalled? (which intercept), decoy
   recalled? (which intercept), unrelated pre-existing notes injected
   (forbidden-rate proxy), useful-but-missed notes.
5. Between iterations: dispose the subagent session (drops its budget
   contribution), tune constants per TASK-014 decisions, re-run.

Ledger table (append per iteration): iteration / relevant hit / decoy hit /
forbidden / misses / notes.

## Iteration 1 ledger (probe 2f43660f, 2026-11-13, post-restart launch)

| item | result |
| --- | --- |
| Turn-start channel | SUPPRESSED (global budget over at subagent first step; silent for subagents by design, steering line skips subagents). No pinned-GLOBAL, no guidance, no search recall in transcript. All turn-start-dependent rows below are UNTESTED, not misses (TASK-010 clause (e)). |
| R1 machinae-ecs fixed-step note | RECALLED via think, verdict useful; probe self-served memory_read then UPDATED the note with the snapshot.ts SNAPSHOT_SPECS/uint32 gotcha (recall -> read -> durable-write loop closed) |
| R2 bitECS query-order note | not recalled (think terms never carried query/sort context; turn-start suppressed) |
| Pre-existing relevant typescript-simulation-style.md | not recalled this iteration (turn-start suppressed) |
| Near-miss accepted | typescript-declarative-best-practices.md, ts-installed-types-are-api-truth.md (think) |
| Forbidden | archive/phpstan-double-include-guestwi.md x2 (think, repeat) |
| Decoys D1/D2 | not recalled (weak evidence: think-only channel) |

Amendments and findings from iteration 1:
1. `archive/` FOLDER does not retire a note: the phpstan note carries
   `archive: false` frontmatter and is correctly indexed (retirement is
   frontmatter-only; indexer purges `archive: true` per
   packages/service/src/indexer.ts archived-purge path). Not a bug; a
   vault hygiene item.
2. Subagent session transcripts live under the SPAWNING session's slug
   bucket (bare-uuid dir), not the cwd slug, even with an explicit cwd.
   Iteration probes: look under --home-derek-src-dsh-plugin-obsidian-mem--.
3. Budget arithmetic: launch probes as the FIRST action after a host
   restart. Headroom was 1120/1500 at audit; parent think-intercepts
   consumed the rest before the subagent's step 1.
4. Probe code result (testbed health): BeaconPulse landed green
   (typecheck + 77 vitest); snapshot.ts SNAPSHOT_SPECS is a mapped type,
   so any new component requires a spec entry (probe discovered it,
   typecheck caught it; changes left uncommitted per protocol).

Iteration 2 plan: restart DSH, launch the SAME probe brief immediately
(unchanged for comparability), zero parent tool steps in between;
then evaluate the turn-start channel rows properly.

Definition of Done: at least one complete iteration ledger; a decision
whether to iterate again.

Depends on: TASK-011, TASK-012, TASK-009, TASK-010.
