# TASK-16 Add `.actrc` and document the act workflow

- Add `.actrc` at the repo root:

```
--pull=false
-P ubuntu-latest=catthehacker/ubuntu:act-latest
--container-archive-skip node_modules
--container-archive-skip coverage
--container-archive-skip packages/core/lib
--container-archive-skip packages/service/lib
--container-archive-skip packages/ui/lib
--container-archive-skip packages/tools/lib
--container-archive-skip packages/events/lib
--container-archive-skip packages/client/lib
--container-archive-skip packages/bundle/lib
```

  `--pull=false` reuses the local image; the archive skips keep host-built
  (host-platform) `node_modules` and committed emit out of the container copy
  so the container installs and builds its own.

- In AGENTS.md "Testing Instructions", document the act invocation, matching
  the local-infer wording but naming this repo's image and workflow:

```
act --env-file .env --secret-file .secrets --container-archive-skip node_modules \
  -W .github/workflows/ci.yml push
```

  State that `.env` and `.secrets` are local-only and gitignored, and that
  `publish.yml` must never be run through act (it would attempt a real
  `npm publish`).

- `.gitignore`: add `.env` and `.secrets` so the local act files cannot leak.

## Definition of Done

- `.actrc` exists and `git check-ignore .env .secrets` lists both.
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
