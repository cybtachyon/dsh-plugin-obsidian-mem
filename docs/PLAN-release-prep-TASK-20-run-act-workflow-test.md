# TASK-20 Run the act workflow test

```
mise x act@0.2.89 -- act push --job verify -W .github/workflows/ci.yml
```

(`.actrc` supplies `--pull=false` and the image mapping. Use
`--reuse` on a second iteration to skip container teardown.)

## Definition of Done

- act exits 0 with the `verify` job's lint, typecheck, build, test, and
  `npm pack --dry-run` steps all green.
- If a step fails, fix the workflow or the repo, re-run, and record the root
  cause here. A failure caused only by the container lacking the onnxruntime
  or milvus native postinstall download is a finding to resolve (allow-build
  configuration or an install flag), not something to skip past.
- `git status --porcelain` is unchanged after the run (act copies the
  workspace; it must not dirty the host tree).
