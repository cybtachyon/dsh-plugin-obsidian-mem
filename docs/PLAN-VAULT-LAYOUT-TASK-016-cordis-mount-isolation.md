# TASK-016 cordis-mount-test-isolation

Objective: fix the pre-existing environment leak in
`packages/service/tests/cordis-mount.spec.ts` ("mounts through ctx.plugin and
publishes the seam"): it asserts a fresh activation (`listVaults() == []`,
state `inactive`) but reads the developer's live provisioned state
(`~/.dsh/obsidian-mem` + `state/vaults.json`), so it fails whenever a default
vault has been provisioned on the machine. Pre-existing as of `HEAD~1` of
TASK-001 (confirmed by the TASK-001 agent on a stashed clean checkout).

Files: `packages/service/tests/cordis-mount.spec.ts` (and any shared test
harness seam it uses).

Steps:
1. Make the mount spec inject an isolated homedir/state (the seam already
   takes `homedir`/fs seams; there is no reason to read the real `$HOME`).
2. The spec must pass identically on a machine with and without a provisioned
   default vault.

Definition of Done: spec green twice in a row on THIS machine (which has a
live `~/.dsh/obsidian-mem`); commit with matching emit if any lib output
changes (expect none: test-only).

Depends on: R2 (runs after Phase 2 refactor so it does not collide with
service.ts churn).
