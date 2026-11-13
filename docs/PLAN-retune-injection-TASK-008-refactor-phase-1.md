# TASK-008 refactor-phase-1

Review the files touched by the previous 7 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Phase-1 watch items (starting points, not exhaustive): the strip rule must
have ONE home (helper in search.ts; harness imports, never restates); the
stop-word list constant lives in exactly one place; eval README/flag naming
matches the harness code; the CJK maximal-run rule's single home is the
sparseQueryText docblock (TASK-018), do not relocate; the TASK-005 zh
probe exists only as prose in the findings doc with its raw dump in /tmp
(not committed), so lift it into a re-runnable read-only script under
docs/research/probes/ and reference it from the findings doc; refresh the
stale `--sparse-radius 2.5` sample commands in docs/research/radius-
tuning-findings.md and scripts/eval/README.md to the shipped 5.0 (harmless
examples today, misleading to a future reader).

Definition of Done: risks resolved or each explicitly waived with a
one-line reason recorded here; gates still green.

Depends on: TASK-007.

## Resolutions

Reviewed the full Phase-1 range `e39fa18..ccf8c4f` (17 commits) via
`git log --stat`. Touched code: `packages/service/src/search.ts`
(+ tracked lib), `search.spec.ts`, `service.spec.ts`,
`scripts/eval/recall-eval.mjs`, `cross-encoder-rerank.mjs`,
`queries-labels.mjs`, root/service `package.json` + lockfile
(stopword dep pair). Dispositions follow the Phase-B review precedent
(`git show 1c9e449:...phase-b.md` Resolutions; the eval-harness
duplication exemption is also vault-recorded as a deliberate keep).

- **Multiple Sources of Truth: RESOLVED by construction (verified, no
  code change).** The stop-word list has exactly one home
  (`SPARSE_QUERY_STOPWORDS`; `stopword` is imported nowhere else —
  grep-verified); the strip rule and the CJK maximal-run rule have one
  home each in the `sparseQueryText` docblock (TASK-018 placement,
  untouched here); `SPARSE_TOKEN_RUN`, the module header,
  `dispatchRoutes` and both harnesses cross-reference by name or import
  the shipped lib (TASK-004 seam). `sparseQueryText` has no restated
  implementation anywhere (grep).
- **Duplicate Code: WAIVED as previously decided.** The two eval
  scripts' near-identical fusion/sort/normalize/metrics copies and the
  PORT_FILE/keepalive client boilerplate shared with the probes are the
  Phase-B review's deliberate keeps (each harness is a self-contained
  byte-diffable experiment record; production internals stay
  consumer-free). Phase-1 added no new duplication: `recall-eval`
  wraps the imported strip once for `--keep-stopwords`, cross-encoder
  calls it directly.
- **Bloaters: WAIVED (pre-existing reviewed shape).** The touched
  bodies are the two harnesses' linear `main()` pipelines; Phase-1
  added imports, one flag case, and the strip application, no new
  responsibility. `search.ts` dispatch code was decomposed in Phase B
  (`flooredSections`, `fallbackFilterExpr`) and stayed so.
- **Data Clumps: not present.** `--keep-stopwords` rides the existing
  CLI opts bag (idiomatic, passed whole); no new multi-variable group
  travels any signature.
- **Shotgun Edits: WAIVED as contract/process.** Constant bumps touch
  src+lib+spec goldens together (tracked-lib policy + deliberate
  literal goldens, Phase B ruling); the 334bc06 fold touched four task
  docs because dispositions fan out by plan process, one line each.
  Code-side, the strip rule's single home makes future strip edits
  surgical (verified by grep).
- **Feature Envy: not present.** `sparseQueryText` manipulates its own
  tokens + the imported list; `sparseSurvivors`/`fuseRrf` own the lite
  row-shape knowledge (Phase B checked, unchanged since).
- **Magic Numbers: FIXED (the watch-item (b) stale examples).**
  Refreshed `scripts/eval/README.md` and the `recall-eval.mjs` header
  sample from the stale 2.5-era (`--sparse-radius 2.5`, `--dense-radius
  0.55`, `--min-score 0.0158`, s25/d055 labels) to production-parity
  knobs (0.78/1.0/5.0, `--min-score 0.016129` annotated as
  `FUSED_SCORE_FLOOR` 1/(k+2)); annotated the one stale row (sparse
  floor 2.5 -> 5.0) in `radius-tuning-findings.md` §Final shipped
  tuning, history-vs-now distinct, all sweep/evidence tables intact;
  labeled the stopword A/B's pinned 2.5 reproduce commands as
  artifact-regeneration, not current-knob examples. Spec fixtures
  (-5.0/-4.9999/-6.0) are the deliberate literal-golden pattern.
- **Overengineering: not present.** Phase-1 added one module-level
  regex constant and a 4-line helper; `SPARSE_TOKEN_RUN` names the
  tokenizer rule even single-use (the `truncateToTokens` precedent from
  Phase B).

Watch items: (a) DONE: the zh probe is committed as
`docs/research/probes/zh-analyzer-probe.mjs` (radius-probe style;
read-only RPCs: getVersion, count, two `chunk_text like` lookups, BM25
searches; port/pid from `/home/derek/.dsh/obsidian-mem-db/.memlite.json`
with `MEMLITE_JSON` override; pinned TASK-002-era split forms plus a
`shipped-strip-out` line computed via the lib-imported `sparseQueryText`)
and referenced from this doc's findings
`docs/research/stopword-strip-findings.md` §"CJK analyzer open question".
Smoke-run 2026-11-13 against the live server (207 rows): exit 0,
mechanism reproduced, corpus drift annotated there. (b) DONE (see Magic
Numbers; TASK-006 sweep tables and the s25 artifact reproduce commands
untouched). (c) DONE (see Multiple Sources of Truth; the eval README
knob table matches both harnesses' `--help` surfaces exactly). The
TASK-018 constant notes were not relocated; `search.ts` is unchanged by
this task.
