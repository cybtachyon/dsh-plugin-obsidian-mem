# Release Prep: dsh-plugin-obsidian-mem 0.0.1

Goal: make this repo a self-contained, publishable npm package
(`dsh-plugin-obsidian-mem@0.0.1`, namespace-less, npmjs.com) whose DSH runtime
files survive a `git clean -fxd`, and whose GitHub Actions build workflow runs
locally under `act`.

Repo: `/home/derek/src/dsh-plugin-obsidian-mem`
(origin `https://github.com/cybtachyon/dsh-plugin-obsidian-mem.git`, branch `main`)
Profile install: `~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem` is a
symlink to this working tree, so the running DSH host loads these files directly.

## Verification Guidelines

- Build gate: `pnpm build` (tsc -b --force, build-client, build-format,
  verify-emit) must exit 0 and leave `git status --porcelain` empty on tracked
  paths.
- Test gates: `pnpm test`, `pnpm test:coverage` (thresholds 85/85/78/85 in
  `vitest.config.ts`), `pnpm lint` (`eslint .`).
- Workflow lint gate: `mise x jactionlint@2.3.0 -- jactionlint` run from the
  repo root reports no findings.
- Pack gate: `npm pack --dry-run` (unblocked by TASK-24) lists every file the
  DSH loader resolves:
  `cordis.patch.yml`, `icon.svg`, `locale/*.json`, `dsh/host.js`,
  `dsh/client.js`, `packages/{core,service,ui,tools,events}/package.json` and
  their `lib/**/*.js` + `lib/**/*.d.ts`.
- Runtime gate: after `git clean -fxd` + `pnpm install`, every `exports` target
  in the root package.json resolves from the profile symlink.
- Commit gate: `prek run --files <paths>` before each commit; the `commit-msg`
  hook rejects external-assistant attribution.
- Never run `pnpm dedupe`-style tooling; root and per-package runtime
  dependency rows are duplicated on purpose (see AGENTS.md).

## Open Questions

Answered inline below (Q1-Q6). See [Questionnaire Answers](#questionnaire-answers).

## Micro-Tasks

### Phase 1: Git-tracking policy for DSH runtime output

- [x] [TASK-01-unignore-lib-build-output](docs/PLAN-release-prep-TASK-01-unignore-lib-build-output.md)
- [x] [TASK-02-update-agents-md-lib-policy](docs/PLAN-release-prep-TASK-02-update-agents-md-lib-policy.md)
- [x] [TASK-03-commit-tracking-policy](docs/PLAN-release-prep-TASK-03-commit-tracking-policy.md)

### Phase 1b: Dispositions for the Phase 1 findings

- [x] [TASK-22-untrack-coverage-output](docs/PLAN-release-prep-TASK-22-untrack-coverage-output.md)

TASK-22's premise was a miscount: `coverage/` was never in the index, so nothing
was untracked. `packages/*/tsconfig.tsbuildinfo` and `dsh/.build/` stay ignored.

Two further findings closed without a task: the stale "(lib is git-ignored
...)" clause in the AGENTS.md install-carrier bullet was already rewritten inside
`76915a9`, and `packages/bundle` emits no `lib` directory because it is a meta
package (TASK-06 and TASK-08 must not expect one). `RESEARCH-FINDINGS.md` was
ruled out of scope there and came back into scope by user decision; see
[TASK-25](docs/PLAN-release-prep-TASK-25-remove-research-findings-scratch.md).
`docs/research/engramory-and-ext-findings.md` (cited by the AGENTS.md DSH Event
Facts heading) stays.

### Phase 2: Namespace-less npm packaging metadata

- [x] [TASK-04-root-package-metadata](docs/PLAN-release-prep-TASK-04-root-package-metadata.md)
- [x] [TASK-05-workspace-versions-and-lockfile](docs/PLAN-release-prep-TASK-05-workspace-versions-and-lockfile.md)
- [x] [TASK-06-npm-pack-contents-verification](docs/PLAN-release-prep-TASK-06-npm-pack-contents-verification.md)
- [x] [TASK-07-commit-packaging](docs/PLAN-release-prep-TASK-07-commit-packaging.md)

### Phase 3: Build artifacts in version control

- [x] [TASK-08-build-and-commit-artifacts](docs/PLAN-release-prep-TASK-08-build-and-commit-artifacts.md)
- [x] [TASK-09-verify-build-idempotency](docs/PLAN-release-prep-TASK-09-verify-build-idempotency.md)
- [x] [TASK-24-drop-devengines-pin](docs/PLAN-release-prep-TASK-24-drop-devengines-pin.md)
- [x] [TASK-25-remove-research-findings-scratch](docs/PLAN-release-prep-TASK-25-remove-research-findings-scratch.md)
- [x] [TASK-26-ignore-idea-directory](docs/PLAN-release-prep-TASK-26-ignore-idea-directory.md)
- [ ] [TASK-10-refactor-review-phase-1-3](docs/PLAN-release-prep-TASK-10-refactor-review-phase-1-3.md)

### Phase 4: GitHub Actions build workflow

- [ ] [TASK-11-copy-publish-workflow](docs/PLAN-release-prep-TASK-11-copy-publish-workflow.md)
- [ ] [TASK-12-copy-release-scripts](docs/PLAN-release-prep-TASK-12-copy-release-scripts.md)
- [ ] [TASK-13-add-act-runnable-ci-workflow](docs/PLAN-release-prep-TASK-13-add-act-runnable-ci-workflow.md)
- [ ] [TASK-14-commit-workflows-and-scripts](docs/PLAN-release-prep-TASK-14-commit-workflows-and-scripts.md)

### Phase 5: `act` framework setup

- [ ] [TASK-15-mise-and-prek-jactionlint](docs/PLAN-release-prep-TASK-15-mise-and-prek-jactionlint.md)
- [ ] [TASK-16-actrc-and-agents-act-docs](docs/PLAN-release-prep-TASK-16-actrc-and-agents-act-docs.md)
- [ ] [TASK-17-lint-workflows-and-commit](docs/PLAN-release-prep-TASK-17-lint-workflows-and-commit.md)

### Phase 6: Clean-tree and live-runtime verification

- [ ] [TASK-18-git-clean-runtime-preservation](docs/PLAN-release-prep-TASK-18-git-clean-runtime-preservation.md)
- [ ] [TASK-19-dsh-runtime-load-verification](docs/PLAN-release-prep-TASK-19-dsh-runtime-load-verification.md)
- [ ] [TASK-20-run-act-workflow-test](docs/PLAN-release-prep-TASK-20-run-act-workflow-test.md)

### Finalize

- [ ] [TASK-21-finalize](docs/PLAN-release-prep-TASK-21-finalize.md)

## Task Dependencies

- TASK-01 → TASK-02 → TASK-03 (tracking policy must land before artifacts are
  committed).
- TASK-04 → TASK-05 → TASK-06 → TASK-07 (metadata before version bump, bump
  before pack audit, pack audit before commit).
- TASK-03 and TASK-07 → TASK-08 (committed artifacts must reflect the final
  tracking policy and final package metadata).
- TASK-08 → TASK-09.
- TASK-09 → TASK-24 → TASK-25 → TASK-26 → TASK-10 (Phase 3b follow-ups from the
  Q7-Q9 answers and the Phase 3 finding; the refactor review reads the whole
  `6a25486..HEAD` range, so it runs last).
- TASK-24 must precede TASK-11 and TASK-13: `publish.yml` ends in
  `npm publish --provenance` and `ci.yml` carries an `npm pack --dry-run` step,
  both of which EBADDEVENGINES while the `devEngines` pin stands.
- TASK-26 must precede TASK-18 and TASK-21, whose gates read
  `git status --porcelain` for empty.
- TASK-10 → TASK-11 and TASK-12; both precede TASK-13 and TASK-14.
- TASK-14 → TASK-15 → TASK-16 → TASK-17.
- TASK-09 and TASK-17 → TASK-18 → TASK-19 → TASK-20 → TASK-21.

## Questionnaire Answers

- Q1 (act target safety): Copy `publish.yml` as a faithful release workflow and
  add `.github/workflows/ci.yml`; `act` runs `ci.yml` only. `act` must never be
  pointed at `publish.yml` (it ends in a real `npm publish`).
- Q2 (un-ignore scope): `packages/*/lib` becomes tracked.
  `packages/*/tsconfig.tsbuildinfo`, `dsh/.build/`, `coverage/`,
  `node_modules/`, editor and log entries stay ignored.
- Q3 (workspace version bump): root plus all seven `packages/*/package.json`
  go to `0.0.1`, with `pnpm-lock.yaml` refreshed.
- Q4 (pending `packages/tools/src/prompt.ts` edit): committed on its own as
  `6a25486 refactor(tools): Tighten the memory prompt section wording`
  (the prompt snapshot was refreshed in the same commit).
- Q5 (`git clean -fxd` collateral): full clean accepted. `node_modules` is
  restored with `pnpm install --frozen-lockfile`; `.idea/` IDE state is
  disposable.
- Q6 (DSH load verification): collect disk plus live-graph evidence
  (`exports` resolution from the profile symlink, throwaway host-entry imports,
  `plugin_manager list_plugins`, `cordis_inspect_list`) without restarting the
  host; the user restarts DSH at the very end.

## Out Of Scope: user's in-flight README edit

`README.md` is being edited in the IDE while this plan runs (release-pitch
rewording). No task in this plan touches `README.md`. Before TASK-18
(`git clean -fxd`) the user must commit or stash it, because a clean destroys
uncommitted work; recorded as a precondition in
[TASK-18](docs/PLAN-release-prep-TASK-18-git-clean-runtime-preservation.md).
