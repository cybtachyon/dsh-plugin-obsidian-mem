# TASK-001-core-memory-git

Port the git wrapper from the reference plugin into core, adapted to this
plugin's vault layout.

Context:
- Reference: `/home/derek/src/dsh-plugin-engramory-ext/packages/core/src/memory-git.ts`
  (MemoryGit, GitRunner, createGitRunner, MemoryGitError, status/log/
  commitAll/ensureRepo parsers). Copy its structure and comment discipline;
  keep argv-array-only git calls (never a shell string).
- Target: new `packages/core/src/memory-git.ts`, exported from
  `packages/core/src/index.ts`.

Adaptations (do not port verbatim):
- Drop remote sync methods the plugin does not use yet ONLY if unused;
  prefer porting `hasRemote`, `fetch`, `pull`, `push`, `behindAhead` too so
  the dream prompt's Step 0 ("when a remote is configured") and audit sync
  INFO lines have a home. Keep them unexercised by product code.
- `MEMORY_GITIGNORE_TEXT`: the sidecar this plugin keeps INSIDE the vault
  root is `.obsidian-mem/` (core `PLUGIN_VAULT_DIR`; the plugin sidecars
  live under `<vault>/.obsidian-mem/metadata/`). The defensive ignore file
  must ignore `.obsidian-mem/` (and keep the tracking-sidecar patterns
  replaced by this one; there is no `.engramory-ext` here).
- `INITIAL_COMMIT_MESSAGE` reads `obsidian-mem: initial memory commit`.
- Commit identity: a store adopted on a machine with no `user.name` /
  `user.email` git config would fail every commit. `commitAll` (and
  `ensureRepo`'s initial commit path) passes
  `-c user.name=obsidian-mem -c user.email=obsidian-mem@localhost` when the
  constructor option `identityFallback` is set (default on): probe once via
  `git config user.email`; when it answers, commit without the overrides.
- `MemoryGitOptions.extraIgnorePaths` stays (defense for a configured path
  inside the root).
- Core stays framework-free (node builtins only, same as reference).

Definition of Done:
- `packages/core/src/memory-git.ts` + barrel exports; constants
  `MEMORY_BRANCH`, `DEFAULT_REMOTE`, `GIT_DIR_NAME`,
  `INITIAL_COMMIT_MESSAGE`, `MEMORY_GITIGNORE_*` exported.
- New `packages/core/tests/memory-git.spec.ts`: scripted-fake `GitRunner`
  specs for ensureRepo (init, gitignore write, initial commit), commitAll
  (clean tree null, nothing-to-commit null, hash return), status parsing
  (rename, conflict markers), log parsing (records, no-commits-yet empty).
  One integration spec forking the real `git` binary in an `os.tmpdir()`
  fixture (init/commit/log round-trip), mirroring the reference's pattern.
- `pnpm build` clean; `pnpm vitest run packages/core` green; commit src+lib
  together after `prek run --files`.

Also (baseline hygiene, do first): commit the user's three prepared prompt
files exactly as they stand
(`packages/service/src/dream.ts`, `packages/tools/src/audit.ts`,
`packages/tools/src/prompt.ts` — the dream.ts/tools-audit.ts ones only the
prompt-constant edits) in their own commit `docs(prompt): prepared
checkpoint and dream prompts (source of truth, unmodified)` BEFORE any code
change, after running `pnpm build` so the matching lib emit rides the same
commit.
