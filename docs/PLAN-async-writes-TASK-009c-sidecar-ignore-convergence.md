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

## Results

Implemented 2026-11-14 in `packages/core/src/memory-git.ts` (src + lib
carriers in one commit):

1. `syncGitignore` now converges the constant patterns on existing files
   too. The pattern list is derived from `MEMORY_GITIGNORE_TEXT` itself
   (`MEMORY_GITIGNORE_PATTERNS`, comments and blanks dropped), so the
   fresh-file text and the convergence pass share one source of truth.
   An existing file gets one additive append: missing constants under a
   sidecar header, then still-missing extras under the existing extras
   header, compared through the same trimmed-line set. Fresh-file
   behavior is unchanged.
2. `ensureRepo` gained `untrackSidecar` as its last leg: `ls-files --
   .obsidian-mem` probes; non-empty output triggers one
   `git rm -r --cached --quiet -- .obsidian-mem` (index only; worktree
   files never move). Failure discipline follows the file's existing
   contract: MemoryGit owns no logger (VaultGitManager logs around
   `ensureRepo`/`commitAll`), so a non-zero `git rm` is absorbed as an
   ordinary outcome exactly like the clean-tree answer in `commitAll`,
   and a non-zero `ls-files` reads as "cannot answer, do not untrack".
   The leg adds no new throw path, so it never unwinds `ensureRepo`;
   a vault that still tracks the sidecar retries the probe on the next
   call.
3. `syncGitignore`'s doc comment now states the invariant: the plugin's
   sidecar is never versioned, whatever the vault's own `.gitignore`
   history is; `MEMORY_GITIGNORE_TEXT`'s comment loses the stale "writes
   once" claim; `ensureRepo`'s comment names the new probe (three probes
   on a healthy repo).

Recovery for already-adopted user vaults (the machinae-game shape): no
manual git is needed. The next memory write drives `commitVault` →
`ensureAdopted` (fresh handle after restart, or the manager's first call
after an upgrade) → `ensureRepo`, which appends `.obsidian-mem/` to the
vault's own `.gitignore` and stages the sidecar's removal through
`git rm --cached`; the same wave's `commitAll` records the removal, and
the converged ignore keeps the sidecar out forever after. A vault that
was fresh-ignored at adoption (the developer default vault) sees empty
`ls-files` output and changes nothing.

Tests (`packages/core/tests/memory-git.spec.ts`, scripted fake plus real
git): constants converge onto an existing `.gitignore` and are
idempotent on the second call; tracked sidecar output triggers the
`git rm -r --cached` argv once; clean or non-answering probes issue no
`git rm`; a failing `git rm` settles without unwinding `ensureRepo`; the
existing extras-append pin stays green (its fixture now carries the
constant so extras alone are pinned). A real-git test recreates the
pre-fix state (user `.gitignore`, force-added sidecar commit) and pins
the full recovery: converged ignore, empty `ls-files` after
`ensureRepo`, the removal landing in the next commit, and sidecar churn
staying invisible afterwards. Service pins updated in
`packages/service/tests/vault-git.spec.ts` for the added `ls-files`
probe in the adoption wave.

Gates: `pnpm build` exit 0 and a second build leaves the tree clean
(264 tsc artifacts verified); `pnpm test` 1113 passed / 2 skipped;
`pnpm lint` clean; `prek run --files` passed on all touched paths.
