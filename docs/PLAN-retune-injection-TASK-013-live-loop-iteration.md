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

## Iteration 2 ledger (probe 3b1c027d, 2026-11-13, restart-then-launch-first)

| item | result |
| --- | --- |
| Turn-start channel | FIRED (gate evaluated before parent post-restart burn; late-spliced into first tool result). GLOBAL pinned yes, guidance line not observed, search rows = 4 |
| Turn-start search rows | budget-gating meta (near-miss), concurrent-git-index note (unrelated), pnpm-dir-cwd (unrelated), +1; ZERO machinae rows |
| R1 / R2 seeds | not recalled (turn-start contaminated, see 1; R2 never surfaced) |
| typescript-simulation-style.md | not recalled |
| Think channel | 3 rounds, 5 injections: transcript-probe, memory-hooks (meta), drupal11-entity-form-di, npm-publish-404, hf-cli-resume. Task-domain terms NEVER appeared in trigger lists |
| Decoys D1/D2 | not recalled |
| Self-serve | 0 calls |
| Code result | task pre-satisfied (see 2); typecheck + 77 tests green |

Findings:
1. PROTOCOL CONTAMINATION (decisive): the probe brief's observation-
   protocol section supplies the turn-start query's dominant vocabulary
   ("recalled_memory", "memory_search", "turn-start", "think"), so all
   4 search rows were memory-meta notes, and the think trigger terms
   leaked the probe's protocol meta-reasoning ("probe", "recall",
   "session", "git") instead of the bitECS task domain. Both channels
   scored zero task-domain rows. Iterations 1-2 are the contaminated
   baseline; the plugin's ranking was never asked a clean question.
2. TESTBED CONTAMINATION: iteration 2 started on a CLEAN tree because
   iteration 1's work had been committed as `58c50e4` "feat(ecs): Adds
   fixed-step beacon pulse system" at 15:09:04, ~10 s after the probe
   session began. Neither probe transcript contains any git-write tool
   call (forensic grep of both transcripts' `tool/call` records; reflog
   shows the bare commit). Author identity + message style match the
   human user; disposition (keep vs reset testbed to f118494) to be
   confirmed with the user, decides the iteration-3 brief.
   Consequence: iteration 2's think signal is weak (probe verified
   rather than wrote).
3. Iteration 3 design: coding-task-ONLY first message (the turn-start
   query source), observation protocol delivered AFTER launch via
   send_message; testbed reset first per the user's disposition of
   58c50e4; requires restart 3 for a clean 1500-token window; brief
   constant from iteration 3 onward.

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
