# TASK-009c — .obsidian-mem sidecar stays out of vault git (inserted from TASK-009 finding 3)

Bug (`packages/core/src/memory-git.ts` `syncGitignore`, source-verified
2026-11-14): the `.obsidian-mem/` constant from `MEMORY_GITIGNORE_TEXT`
lands ONLY when the vault root has no `.gitignore` at all; an existing
(user's own) `.gitignore` receives only the option-driven extras. On such
vaults the plugin's sidecar
(`<vault>/.obsidian-mem/metadata/obsidian-mem-state.json` and siblings)
gets committed by the per-write `git add -A` and churns every commit wave
(observed on the machinae-game testbed). The AGENTS/core note calls the
pattern load-bearing, so "existing files may be the user's own" must not
outweigh it. AGENTS.md records that the sidecar is INSIDE the vault root
here, unlike the reference plugin.

Fix, additive and idempotent, in `MemoryGit`:

1. `syncGitignore` converges the CONSTANT patterns on existing files too,
   through the same missing-line append mechanism extras already use
   (compare trimmed lines; keep the additive-only rule; a user who deleted
   the pattern gets it back on the next `ensureRepo`, which is the intent).
2. Untracking for already-adopted vaults: in `ensureRepo` (post-adoption,
   inside the caller's lane), check `git ls-files -- <sidecar dir>` and,
   when non-empty, run `git rm -r --cached --quiet -- <sidecar dir>` (argv
   through the injected GitRunner only; never touches worktree files). The
   next commit wave records the removal and the ignore keeps it out
   forever. A failing `git rm` warn-logs and never unwinds ensureRepo
   (warn-don't-die, same policy as the rest of MemoryGit callers).
3. Doc comments: `syncGitignore`'s comment loses the "constants land only
   on first write" clause and states the invariant: the plugin's sidecar
   is never versioned, whatever the vault's own `.gitignore` history is.

Tests in `packages/core/tests/memory-git.spec.ts` with the fake GitRunner:
(a) existing `.gitignore` without the constants receives a missing-line
append that includes `.obsidian-mem/`, idempotent on the second call;
(b) adoption where `ls-files` answers tracked sidecar paths issues the
`git rm -r --cached` argv once; (c) clean vault (nothing tracked) issues
no `git rm`; (d) existing-file extras-append behavior stays pinned.

Definition of Done:

- `pnpm build` exit 0, tree clean; `packages/core/lib` carriers ride.
- Core suite green; `pnpm lint` green; `prek` green on touched paths.
- Note in the task file Results how existing adopted vaults (the developer's
  own default vault is fresh-ignoring already; user vaults are the case)
  recover on the next write wave, no manual git.
