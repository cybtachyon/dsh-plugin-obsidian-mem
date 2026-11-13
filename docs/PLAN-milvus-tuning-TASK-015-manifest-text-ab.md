# Manifest-text A/B experiment (iteration-1 follow-up)

Question: does the workspace-manifest text that turnStart concatenates
into the search query (tokens like `.ts typescript javascript vite
vitest three bitecs`) contaminate both routes so that cross-project
notes outrank in-domain notes? Compare, per machinae-game query, the
production-shape page (split-rrf, radii 0.78/2.5, fused floor 1/(k+1))
for `query = user text` vs `query = user text + "\n\n" + manifest`.

Ground truth for this experiment (labels the harness lacks):
- POS (relevant): machinae-game/machinae-game-bitecs-query-registration-for-sim-tests.md,
  machinae-game/machinae-game-three-js-instanced-render-batching.md,
  typescript-simulation-style.md
- NEG (forbidden): unity-dots-entity-query-chunk-iteration.md,
  react-three-fiber-gallery-viewer-memoization.md, guestwise/*, lywa/*,
  drupal/*, archive/*
Acceptable/unlisted: generic TS-process notes (typescript-verify-
before-done, ts-installed-types-are-api-truth) count neutral.

Queries: the 3 machinae-game queries from scripts/eval/queries-labels.mjs
plus the probe delegation prompt (its turn-start text, reconstructed).
Manifest: core.scanManifest('/home/derek/src/machinae-game') +
manifestQueryText, once, reused for all queries (that is what
turnStart does per session).

Method: read-only searches + the same client fusion/floors as
scripts/eval/recall-eval.mjs split-rrf. Emit per-variant per-query top-6
pages with POS/NEG marks, and aggregate P@6 / forbidden count / POS-hits.

Output: append the table + verdict to PLAN-milvus-tuning.md
"Manifest-text A/B" subsection; if manifest text measurably worsens
both-route contamination, file a scoped events/turnStart.ts change
(drop manifestQueryText from the query, keep it for the guidance line)
as a task for user approval.

Definition of Done: table in the plan; explicit adopt/reject verdict on
the turnStart.ts change.

## Results (2026-11-13, production-shape pipeline: radii 0.78/2.5, fused floor 1/(k+1))

| variant | relevant | forbidden | returned | P@6 | forbRate |
| --- | --- | --- | --- | --- | --- |
| user-text-only | 5 | 2 | 12 | 0.417 | 0.167 |
| user-text+manifest | 4 | 2 | 15 | 0.267 | 0.133 |

Per-query pages show the mechanism: the manifest token soup
(`.ts .json .md typescript javascript ...`) pulls generic-process notes
(vitest-lazy-cjs, dsh-session-transcript-probe, dsh-local-infer-
profile-symlink) into the dual-route agreement band on every query,
displacing in-domain POS rows (machinae-save-restore lost its page
entirely text-only; combat kept two POS rows).

- [x] Verdict: ADOPT a scoped events/turnStart.ts change: the search
  query becomes the user text alone; scanManifest output stays for the
  guidance line only. Evidence above; 4 labeled machinae queries (the
  only class where POS notes exist). Full-17 harness unaffected
  (it never sent manifest text).
