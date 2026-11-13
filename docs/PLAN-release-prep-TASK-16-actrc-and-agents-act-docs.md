# TASK-16 Add `.actrc` and document the act workflow

- Add `.actrc` at the repo root:

```
--pull=false
-P ubuntu-latest=catthehacker/ubuntu:act-latest
```

  `--pull=false` reuses the local image. Host-built `node_modules/` and
  `coverage/` stay out of the container copy through act's `--use-gitignore`,
  which act 0.2.89 defaults to true and which is the correct mechanism here;
  the `--container-archive-skip` lines this task originally prescribed name a
  flag that does not exist in act 0.2.89 and would break every `act` run that
  parses `.actrc`. The tracked `packages/*/lib` emit is copied in and rewritten
  by the `ci.yml` build step inside the container.

- In AGENTS.md "Testing Instructions", document the act invocation, naming
  this repo's image and workflow:

```
act --env-file .env --secret-file .secrets -W .github/workflows/ci.yml push
```

  State that `.env` and `.secrets` are local-only and gitignored, and that
  `publish.yml` must never be run through act (it would attempt a real
  `npm publish`).

- `.gitignore`: add `.env` and `.secrets` so the local act files cannot leak.

## Definition of Done

- `.actrc` exists, `act --help` parses it from the repo root without an unknown
  flag error, and `git check-ignore .env .secrets` lists both.
- AGENTS.md names the exact act command and the publish-workflow prohibition.

## Result (TASK-16 closeout)

- `.actrc` exists at the repo root and `.gitignore` gained `.env` and
  `.secrets`; `git check-ignore .env .secrets` lists both. Neither file was
  created.
- Deviation from the task body: the seven `--container-archive-skip` lines
  were dropped. `act 0.2.89` (the pinned host version) has no
  `--container-archive-skip` flag, and with those lines `.actrc` made every
  act invocation from the repo root fail with
  `Error: unknown flag: --container-archive-skip`, including
  `act push --list -W .github/workflows/ci.yml`. The flag appears in no act
  release the upstream docs describe, so the body's block was written
  against a tool capability that does not exist.
- The same outcome holds without the flag: `node_modules/` and `coverage/`
  stay out of the container copy through act's default `--use-gitignore`
  (both are gitignored), and the tracked `packages/*/lib` emit is copied in
  and rewritten by the ci.yml build step (`tsc -b --force`) inside the
  container. `.actrc` keeps `--pull=false` and the
  `-P ubuntu-latest=catthehacker/ubuntu:act-latest` mapping and records
  this in comments.
- AGENTS.md Testing Instructions document the act command (body wording
  minus the unsupported flag), the local-only gitignored `.env`/`.secrets`,
  and the never-run-`publish.yml`-through-act prohibition; a `jactionlint`
  bullet documents the new pin and hook. Nothing else in AGENTS.md
  contradicted the final `.actrc`.
- Committed in TASK-17's `9f573df ci: Configure act for local GitHub
  Actions runs`.
