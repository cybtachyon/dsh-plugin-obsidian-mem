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
