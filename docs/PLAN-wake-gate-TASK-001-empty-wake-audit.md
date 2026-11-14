# TASK-001: empty-wake-audit

Phase A (spec Step 1.1). Read-only against the live collection
(`/home/derek/.dsh/obsidian-mem-db/.memlite.json`, attach only; RPC
allow-list connectPromise, getVersion, count, query, search; never a
write/DDL/spawn/kill).

Write `docs/research/probes/wake-audit-probe.mjs` following the house
probe style (`zh-analyzer-probe.mjs`, `radius-probe.mjs` as templates:
module docblock with the RPC allow-list, keepalive-suppressed client,
MEMLITE_JSON override, JSON-lines output, progress on stderr, no
timestamps). It:

1. counts rows via the production count guard;
2. fetches `chunk_id`, `source_path`, `wake_keywords` for every row in
   pages (`query` with `chunk_id > <last seen>` + `limit`, ascending by
   primary key; `ARRAY_LENGTH` filters are unproven on lite 3.2.2, so
   count empty arrays client-side);
3. emits a FINAL line: total rows, empty-wake rows, empty rate;
4. emits a TERMS line: global wake-term frequency, top 40 (this is the
   generic-intent-marker pollution evidence for the PARTIAL follow-up).

Record the counts, the rate, and the STOP decision against the spec's
>5% threshold in a new section "Pre-flight measurements (2026-11-13)"
of `docs/research/sparse-wake-gate-spec.md`. Commit probe + spec doc
(`docs:` or `feat(probes):` style; run `prek run --files` first).

Definition of Done: probe runs clean against pid/port from
`.memlite.json`; counts + rate + STOP/no-STOP recorded in the spec doc;
commit hash exists; if rate > 5%, STOP the whole plan and surface the
wake-extraction fix as the next task (do not proceed to Phase B).
