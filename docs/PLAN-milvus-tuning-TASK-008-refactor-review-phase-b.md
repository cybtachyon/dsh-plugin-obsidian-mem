# Refactor: review Phase B search-tuning commits

Review the files touched by the previous 4 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Context: the Phase B commits touched `packages/service/src/search.ts`
(route params + constants), its spec, the eval harness, and probe scripts.
Watch for the tuning constants drifting from the harness's defaults (one
source of truth for production values; the harness takes them as flags)
and for harness/probe duplication of the dispatch assembly. Gates per
AGENTS.md; behavior-preserving only (no metric changes without a plan-file
row).

Definition of Done: each listed risk answered (fixed or explicitly waived
with a one-line reason in the commit message); gates green; committed.

## Resolutions

Reviewed: 4814c74, 91e3d2d, 0cbb07e, 04c15d7, ac6260e, 9ebfc24, c47a0a8,
58d1755, 9cf4816, 4abf302, 970e2f8, c24000f. Files: `search.ts`,
`search.spec.ts`, `turnStart.ts`, `scripts/eval/recall-eval.mjs`,
`scripts/eval/cross-encoder-rerank.mjs` (+ eval README).

- **Multiple Sources of Truth: FIXED, two clusters.**
  (1) Both eval scripts restated the production tuning constants as
  local literals, and `cross-encoder-rerank.mjs`'s copy had drifted:
  `FUSED_SCORE_FLOOR = 1/(k+1)` while production shipped 1/(k+2)
  (c24000f). `search.ts` now exports
  `RRF_RANKER_K, DENSE_SEARCH_EF, DENSE_SEARCH_RADIUS, DENSE_RANGE_MAX,
  SPARSE_SEARCH_RADIUS, FUSED_SCORE_FLOOR, CANDIDATE_OVERSAMPLE`
  alongside `SEARCH_OUTPUT_FIELDS` (the scripts already imported that
  from `packages/service/lib/search.js`, so the seam was proven
  loadable); both harnesses import the constants, recall-eval's CLI
  defaults ARE the production values, and the eval README cites the
  seam instead of literal values. Fix: 671b2bb.
  (2) The fused-floor RULE text was restated five times inside
  `search.ts` (module header, the constant, both `minScore` docs, both
  application sites). It now has one authoritative statement on
  `FUSED_SCORE_FLOOR`; every other doc cross-references it by name.
  Fix: aa1e64f.
- **Duplicate Code: FIXED within files; cross-file harness duplication
  deliberately kept.** `hybridSearch`'s tail and
  `searchExactSections`' fallback tail were the same
  `toResults`-floor-`topSections` sequence; one `flooredSections`
  helper now carries both (aa1e64f). The fusion/sort/normalize copies
  shared by the two eval scripts (and their copy of the production
  dispatch) are NOT abstracted into a shared module: each script is a
  self-contained, byte-diffable record of the run that justified a
  plan-file row, and production internals must not grow a second
  consumer-shaped API for the harnesses' sake. Waived as designed.
- **Bloaters: FIXED (mild).** `searchExactSections` had the fallback
  filter composition inline; it moved to `fallbackFilterExpr`
  (aa1e64f). `runTurnStartRecall`'s inline search + fresh-source
  filter + token-trim block moved to `budgetedRecallSources` so the
  flow reads as its documented steps (1c9d05a).
- **Data Clumps: FIXED in events; not present in service.**
  `claimTurnStart` un-packed the whole `agent/pre-step` payload into
  four parameters that traveled together; it now takes
  `PreStepPayload` (1c9d05a). `dispatchRoutes(deps, queryText, dense,
  expr, candidateLimit)` was checked: those are the freshly computed
  inputs to the one function that consumes the group, not a clump; a
  parameter object would be speculative.
- **Shotgun Edits: the residue is FIXED; the lib-in-every-commit shape
  is the repo contract, not a smell.** The real scatter was one floor
  rule in five comments and one constant set in four files; both are
  now single-home (671b2bb, aa1e64f). src+lib+spec in every tuning
  commit is the tracked-lib policy (AGENTS.md), and docs/plan ticks
  are the plan-ownership process.
- **Feature Envy: not present, checked.** `fuseRrf`,
  `sparseSurvivors`, and `toResults` manipulate `RawSearchRow` because
  this module OWNS the lite row-shape knowledge (negated BM25, G10
  projection); `buildFilterExpr` owns expression rendering for
  `FilterCriteria`; `guidanceLine` owns manifest->text formatting. No
  method's behavior belongs to another class.
- **Magic Numbers: not present in method bodies, checked.** All search
  knobs are named constants; the spec's `1/61`, `1/62` fixtures are
  the RRF formula made visible and its decimal cutoffs carry inline
  WHY comments. The dispatch-shape goldens pin literal
  `ef/radius/range_filter` values DELIBERATELY: a spec that imported
  the constants could not catch production drift. The stale `1/61`
  literals in the cross-encoder header/USAGE text were replaced by
  interpolated imported constants (671b2bb).
- **Overengineering: FIXED (one case).** Single-caller
  `dedupeBySection` (a one-line `topSections` body) collapsed into
  `topSections` (aa1e64f). Kept deliberately: `candidatesFor`,
  `collectionOf`, `tokenBudget`, `quoteExpr`, `listLiteral` each name
  a rule with 2+ call sites, and `truncateToTokens` names the
  token->char approximation rule even at one site.

Deliberately untouched: `docs/research/probes/radius-probe.mjs` (a
historical research record of what was run against the pre-split
shape; retyping it would falsify the probe), eval scripts' cross-file
fusion copies (above), spec golden literals (above), and
`packages/service/tests/search.spec.ts` (no risk found; it stays
self-contained per the golden rule).
