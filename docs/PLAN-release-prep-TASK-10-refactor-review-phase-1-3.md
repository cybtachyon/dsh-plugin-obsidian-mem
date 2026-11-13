# TASK-10 Refactor: review the Phase 1-3 changes

Review the files touched by the previous 9 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Scope guard: this covers `6a25486..HEAD` (the tracking policy, the 0.0.1
metadata, the committed emit, and the Phase 3b follow-ups). The only
hand-edited source surfaces are `.gitignore`, `AGENTS.md`, the eight
`package.json` files, and `scripts/`; `packages/*/lib` is machine emit. A
legitimate finding is, for example, the package version, the npm `files` list,
or the `exports` map being restated somewhere it should be derived (scripts,
docs, vitest or eslint config), or a plan/task DoD that is structurally
unsatisfiable as written. Record findings and resolutions under `## Findings` in
this file. If nothing qualifies, say so explicitly.

## Findings

Reviewed range: `6a25486..HEAD` = 14 commits (`git log --oneline 6a25486..HEAD
| wc -l`; the task body's "previous 9 commits" predates the Phase 3b commits,
the range is authoritative). Hand-edited files the range touched: `.gitignore`,
`AGENTS.md`, the root and seven `packages/*/package.json`,
`packages/service/src/milvus/launcher.ts` (one comment repoint in 37dc88a),
`README.md` (3b2e01b), `docs/research/milvus-transformers-findings.md`
(be9056c), `RESEARCH-FINDINGS.md` (deleted in 37dc88a), and the plan/task docs.
`packages/*/lib` (232 tracked files) and `dsh/client.js` are machine emit;
`scripts/` was not touched inside the range (its claims are reviewed per the
scope guard).

### Risk categories

- **Multiple Sources of Truth** — 3 findings, all resolved:
  - F-1 `scripts/build-client.mjs` hardcoded the ModuleLoader id literal
    `'dsh-plugin-obsidian-mem'`, restating the root `package.json` name that
    the header comment itself names as the source of truth. A rename would
    ship a card whose loader id no longer matches the bare package the
    `dsh.client` scan keys on, silently dropping the browser card. Resolved:
    the script now reads `name` from the root `package.json`; a full
    `pnpm build` after the change regenerates `dsh/client.js` byte-identical
    (verified: `git status --porcelain` clean for `dsh/`).
  - F-2 `scripts/build-format.mjs` hardcoded the six `packages/*/lib` target
    dirs while `scripts/verify-emit.mjs` derives its package set from a
    `packages/` scan. Two sources for one package set: a new package would
    pass verify-emit but skip newline normalization, and because
    `packages/*/lib` is tracked since `76915a9`, the stale emit would break
    the clean-tree build gate. Resolved: target dirs are derived from the
    `packages/` scan (behavior identical on the current tree; a package
    without `lib/` is skipped by the existing stat guard).
  - F-3 `scripts/verify-emit.mjs` computed `expectedOutputs()` twice per
    package (broken-check and printed total). Resolved: one derivation
    shared by both; log output unchanged (`232 tsc artifacts intact across
    6 packages`).
  - Noted, not defects (inherent to npm packaging, no derivable single
    source): the `0.0.1` row in each of the eight `package.json` files (no
    `0.0.1` restatement exists in scripts or lint/test config; grep clean);
    the root `files` list's per-package `lib/**/*.js` + `lib/**/*.d.ts`
    stanzas (npm `files` entries are root-relative and cannot inherit a
    package's own `files`); the cordis `>=4.0.6-alpha.2` row appearing as
    root `peerDependencies` and bundle `devDependencies` (the documented
    dual-declaration pattern in AGENTS.md, ranges in lockstep;
    `@huggingface/transformers`, `@zilliz/milvus2-sdk-node`, `gray-matter`
    verified in lockstep between root and owning packages).
- **Duplicate Code** — none. The repeated `files`/`exports` stanzas across
  the five published packages cross npm package boundaries; npm requires a
  declaration per package.
- **Bloaters** — none. The range changed no method bodies; the three build
  scripts stay single-purpose.
- **Data Clumps** — none. The range is config, docs, and comment text.
- **Shotgun Edits** — none. `b98d31d` touching eight `package.json` files is
  a workspace version bump (inherently multi-file); `be9056c` and `37dc88a`
  each pair a change with its own doc/emit consequence, which is cohesion,
  not scattering.
- **Feature Envy** — none. The only `packages/*/src` touch is a doc comment.
- **Magic Numbers** — none. The candidate literal (`size < 2` truncation
  signature in `verify-emit.mjs`) carries its explanation at the use site.
- **Overengineering** — none.

### DoD drift (claims git or npm contradict)

- TASK-25's premise "It is also always-included by npm, so it ships in the
  published tarball" is false, and its DoD "its entry count dropped" is
  unsatisfiable: the root `files` allowlist never listed `RESEARCH-FINDINGS.md`
  (`git show be9056c^:package.json`), and npm's always-included set does not
  cover it. Measured: `npm pack --dry-run` on a `git archive` checkout of
  `be9056c` (scratch file still on disk) reports 99 total files with no
  `RESEARCH-FINDINGS.md` row; the same command at HEAD reports 99. The count
  did not drop. TASK-06's own record ("`RESEARCH-FINDINGS.md` ... NOT in the
  tarball") already contradicted the TASK-25 premise. The deletion commit
  `37dc88a` itself is correct on its verifiable points (file gone, src cite
  repointed, `launcher.js`/`launcher.d.ts` emit carried in the same commit).
- This task's own scope note is imprecise: "previous 9 commits" (range holds
  14); "The only hand-edited source surfaces are ... and `scripts/`" — git
  shows hand edits to `packages/service/src/milvus/launcher.ts` (37dc88a),
  `README.md` (3b2e01b), and `docs/research/milvus-transformers-findings.md`
  (be9056c), while `scripts/` was untouched in range.
- Verified true (not drift): TASK-24's `EBADDEVENGINES` story reproduced live
  (running `npm pack --dry-run` on a `git archive` checkout of `3b2e01b` dies
  with `EBADDEVENGINES ... does not match "npm" for "packageManager"`); the
  pin is gone and npm runs from the repo root at HEAD. TASK-26's
  `git check-ignore -v` DoD matches `.gitignore:16 .idea/` for all three
  probe paths. TASK-08's closeout counts match git (`packages/*/lib` tracked =
  232, core = 32, matching the 232-file emit commit `cb523da`). The AGENTS.md
  lib-tracking, build-chain, and carrier (`dsh/host.js`, `dsh/client.js`)
  claims all match HEAD.

### Pre-existing, outside the range (not changed here)

- `cordis.patch.yml` drift: the root copy and `packages/bundle/cordis.patch.yml`
  are two hand-maintained files, and the bundle copy asserts "Kept in sync
  with the root cordis.patch.yml; only the header differs." Both were created
  already-different in `70c4438` (before this range) and are untouched since;
  the structural mount lines are identical today (diff of non-comment lines is
  empty), but the comment bodies have diverged (42 vs 38 lines), so the sync
  claim is false. A follow-up should re-sync the comments or drop the claim.

### Verification (real commands, real exits)

- Baseline before edits: `pnpm lint` 0; `pnpm test` 0 (42 files passed, 1
  skipped; 665 tests passed, 2 skipped); `pnpm build` 0 with a clean tree
  (emit in sync with source; no stale-emit finding).
- After the F-1..F-3 script edits: `pnpm build` 0 twice; regenerated
  `dsh/client.js` byte-identical (no `dsh/` diff); no `packages/*/lib` diff;
  final `pnpm lint` 0, `pnpm test` 0, `npm pack --dry-run` 0 (99 files,
  every loader-resolved path present), `git status --porcelain` empty.
- `prek run --files <paths>` run before each commit (see the two commits
  referenced by the plan checkbox for this task).
