# TASK-011 seed-test-memories

SEQUENCING GUARD (added 2026-11-13): do NOT seed before TASK-005 and
TASK-006 finish. The offline eval harnesses replay a LABELED query set
against the same live collection these notes would index into; seeded
rows are unlabeled and would contaminate P@k/forbidden-rate baselines.
GUARD SATISFIED 2026-11-13 (TASK-006 committed). Corpus note: the
collection sits at 205 rows (drifted from 206); re-verify the label
families still resolve before trusting any post-seeding eval numbers.

Use `memory_write` (never direct file writes) to seed the default vault
`/home/derek/.dsh/obsidian-mem/` with the iteration's probe set. Record
EVERY seeded note path in the Seeding log table below; TASK-016 archives
exactly those.

Seed design per machinae-game task flavor:
- RELEVANT set (2..4 notes): machinae-game / TypeScript-simulation work
  that the subagent's task genuinely needs (e.g. entity/sim-loop, ECS, or
  tsconfig conventions for that repo). Hooks name the activity with the
  words the reader is thinking while working (per the memory-hooks
  naming note in the vault).
- DECOY set (2..4 notes): share overlapping verbiage (TypeScript, game,
  loop, entity, state) but belong to other projects (guestwise, lywa,
  drupal-ish) or describe unrelated activity; they must NOT be recalled
  for this task.
- Wake-word hygiene: give decoys and relevant notes plausible
  frontmatter; do not label anything "decoy" in the content in a way the
  agent could read as an instruction.

Seeding log (append per iteration):

| iteration | path | kind |
| --- | --- | --- |

## Iteration 1 design (2026-11-13)

Probe task (constant across iterations, from the testbed scout): add a
fixed-step `beaconPulseSystem` to machinae-game (increments a Uint32
`BeaconPulse` component once per world step), register it with the other
systems, add a Vitest test driving it through `test/systemStepper.ts`,
run `pnpm test` and `pnpm typecheck`.

Wake-signal requirement (TASK-010 finding): the live vault's heuristic
wake_keywords are dominated by generic intent markers, so notes must
carry explicit wake signals or think/topic matching under-detects.
Every seeded note MUST: name the activity in the index hook (the
memory-hooks naming rule), mention `machinae`, `bitECS`, `ECS system`,
`fixed-step`, `world`, `step`, `component`, `beaconPulse`/`BeaconPulse`,
`systemStepper`, `Vitest` naturally in body text and inline code.
No seeded note may quote probe-prompt sentences verbatim.

RELEVANT seeds (should recall for the probe task):
- R1 `machinae-ecs-system-conventions`: adding a new
  `src/ecs/systems/*.ts` system: one file per system, a pure function of
  the world, no wall-clock/DOM reads, register beside the existing
  systems, test by building a world and stepping with `systemStepper`.
- R2 `machinae-bitecs-query-order-trap`: bitECS 0.4 `query()` returns
  ids in swap-remove order; spread into a local array and sort by entity
  id when order matters; `ComponentRef = any` means wrong component
  objects are runtime bugs.

DECOY seeds (vocabulary overlap, must NOT recall):
- D1 `machinae-archive-ui-prototype`: an archived 2D prototype's Vue
  component state-machine inventory (shares component/state/vocab,
  wrong project, unrelated activity).
- D2 `obsidian-mem-wake-heuristics-audit-note`: a note about memory
  recall wake-word auditing (shares query/keyword/world vocabulary,
  belongs to this plugin's meta-work, irrelevant to writing a game
  system).

Pre-existing relevant rows already in the collection (expected hits):
the TypeScript/simulation-style machinae note (eval label R family).

Definition of Done: table complete; notes visible via a direct
`memory_search` probe before the live run (indexer caught up).

Depends on: none (re-runnable per iteration).
