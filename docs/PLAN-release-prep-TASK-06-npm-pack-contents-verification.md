# TASK-06 Verify the npm tarball contents

Run the pack dry-run and compare the file list against what DSH resolves at
load time. No file changes unless the audit finds a gap.

```
npm pack --dry-run --json > /tmp/obsidian-mem-pack.json
```

Required in the tarball:

- `package.json`, `README.md`, `LICENSE`
- `cordis.patch.yml`, `icon.svg`, `locale/en.json`
- `dsh/host.js`, `dsh/client.js`
- `packages/{core,service,ui,tools,events}/package.json`
- for each of those five: `lib/**/*[!.].js` and `lib/**/*.d.ts`

Must NOT be in the tarball: `packages/*/src/**`, `packages/client/**`,
`packages/bundle/**` (unless `exports` references it), `tsconfig*`,
`tests/**`, `coverage/**`, `.github/**`.

Note: `packages/*/lib/**` only appears once TASK-08 has built it. If the pack
audit runs before the build, build first (`pnpm build`) or record the gap and
re-run the audit in TASK-08.

## Definition of Done

- Every required path is present in the pack list; every forbidden path absent.
- The findings (including intentional exclusions) are written into this file
  under a `## Findings` heading.

## Findings

Audited 2026-11-12 against the tree at `ef720aa` plus the uncommitted TASK-04/05
metadata and version edits. Result: PASS, no gap, no file changes from this task.

Tool used: the prescribed `npm pack --dry-run --json` is refused in this repo.
npm 11.20.0 fails with `EBADDEVENGINES` ("Invalid name \"pnpm\" does not match
\"npm\"") because `devEngines.packageManager` pins pnpm 12.18.0. Same refusal for
`npm view --json .` (its `--force` variant instead queries the registry and 404s,
since the package is not published yet). Fallback per plan:
`pnpm pack --pack-destination /tmp` produced
`/tmp/dsh-plugin-obsidian-mem-0.0.1.tgz`, listed with `tar -tzf`.
`npm pack` therefore cannot be the CI pack gate until the devEngines pin is
relaxed or the workflow runs the audit through pnpm; TASK-11/TASK-13 should use
the pnpm form.

Tarball: 99 entries. 13 non-lib lines, 86 lib lines (43 exact `.js`/`.d.ts`
pairs: core 8, service 15, ui 1, tools 10, events 9; all pairs symmetric, no
orphan). Every required path is present: `package.json`, `README.md`,
`LICENSE`, `cordis.patch.yml`, `icon.svg`, `locale/en.json` (the only locale
file), `dsh/host.js`, `dsh/client.js`, and `package.json` + full
`lib/**/*.js` + `lib/**/*.d.ts` for `packages/{core,service,ui,tools,events}`.
The packed `package.json` files (root and the five shipped packages) all carry
version `0.0.1`.

Forbidden patterns: zero matches for `packages/*/src/**`, `packages/client/**`,
`packages/bundle/**`, `tsconfig*`, `tests/**`, `coverage/**`, `.github/**`.

Intentional exclusions (kept, do not "fix"):

- Source maps. 116 `.js.map`/`.d.ts.map` files exist under `packages/*/lib` on
  disk but the `files` list matches only `*.js` and `*.d.ts`, so no map ships.
  That is why the packable lib row count is 86, not the disk count.
- `dsh/.build/`, `packages/*/tsconfig.tsbuildinfo`, `.idea/` stay out by the
  `files` whitelist.
- `packages/client` and `packages/bundle` are absent by design: `exports`
  references neither, and `packages/bundle` emits no lib (meta package).

Correction to an open assumption: `AGENTS.md`, `RESEARCH-FINDINGS.md`,
`mise.toml`, `prek.toml`, and `pnpm-workspace.yaml` are NOT in the tarball.
npm's always-included set is only `package.json`, `README*`, `LICENSE`, and the
`main` entry; pnpm pack honored the `files` whitelist exactly. The 99-entry list
is whitelist plus those always-included files, so there is nothing to trim.

Metadata shape note (carried from TASK-04): `repository.url` is
`https://github.com/cybtachyon/dsh-plugin-obsidian-mem` with no `.git` suffix,
matching the provenance-verified `dsh-plugin-local-infer` package convention.

Source-of-lib caveat: the `packages/*/lib` rows were packed from the untracked
on-disk lib (build output present since the Phase 1 commits). pnpm pack reads
the filesystem, not git, so the audit is valid today; after a `git clean -fxd`
(TASK-18) the same audit requires TASK-08's committed artifacts or a
`pnpm build` first, exactly as the task note above anticipates.
