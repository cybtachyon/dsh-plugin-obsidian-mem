# TASK-008: commit-green

Phase B close-out (spec Step 2.3).

1. `pnpm build` (tsc -b --force re-emits every lib; lib IS tracked),
   `pnpm test`, `pnpm lint` all green.
2. `prek run --files <every touched path>`.
3. ONE commit carrying: `packages/service/src/search.ts`, the rebuilt
   `packages/service/lib/**`, `packages/service/tests/search.spec.ts`,
   `packages/service/tests/service.spec.ts` (and any other touched spec),
   `scripts/eval/recall-eval.mjs`, `docs/research/probes/zh-analyzer-probe.mjs`.
   Message states the gate, the kill switch
   (`SPARSE_WAKE_GATE_ENABLED`), the cap (`SPARSE_WAKE_GATE_MAX_TOKENS`),
   and cites `docs/research/sparse-wake-gate-spec.md`. No external
   assistant attribution (commit-msg hook rejects it).
4. `git status` clean afterwards.
5. Report the commit hash in the task-completion output; TASK-012
   records it in the spec doc.

Definition of Done: three gates green, one commit exists, tree clean.
