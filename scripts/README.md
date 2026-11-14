# scripts/

Repository maintenance scripts (build helpers plus the live-index
operations). Evaluation harnesses live in [`eval/README.md`](eval/README.md);
nothing eval-related belongs here and nothing maintenance-related belongs
there.

- `build-client.mjs`, `build-format.mjs`, `verify-emit.mjs` — the
  `pnpm build` pipeline steps (client bundle, artifact newline
  normalization, emit verification).
- `check_commit_msg_attribution.py` — the installed prek `commit-msg` hook.
- `prefetch-model.mjs` — pre-seed the transformers.js model cache for
  offline machines.
- `release/` — release tooling.
- `live-reindex.mjs` — reindex the LIVE production collection through the
  indexer's own code path so stored trigger columns (`wake_keywords`,
  `trigger_extensions`, `trigger_frameworks`) reflect a wake-extraction or
  chunker code change. Stored wake arrays are computed at index time, so
  such a fix only reaches live rows once the indexer rewrites them
  (TASK-015, PLAN-wake-gate). Attach-only to the running milvus-lite
  (`{port,pid}` from `<dbDir>/.memlite.json`); never a raw collection
  mutation, drop, rebuild, or state-file deletion — the forced reindex is
  driven through the indexer's `IndexerFs` seam (see the module docblock
  for the why). `--check` prints the plan and writes nothing. Touch no
  vault notes while it runs: the live host's watchers may otherwise
  re-index a note with its own in-memory extraction code. After a run,
  verify with the read-only probe
  `docs/research/probes/wake-audit-probe.mjs`.
