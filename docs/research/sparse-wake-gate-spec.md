# Sparse-leg wake gate: implementation and A/B instructions

Status: APPROVED FOR IMPLEMENTATION (2026-11-13 user request). Option 3
of the route-attribution analysis; Option 4 (dual BM25 fields) is the
approved escalation ONLY if the A/B here under-delivers.

## Problem (measured, not theorized)

Production-parity artifact
`docs/research/eval-split-strip-on-d078-s50-k60-m016129.json`, 17 labeled
queries, 76 page rows, class x route: relevant 15 both / 4 dense /
**0 sparse-only**; forbidden 9 both / 4 dense / **6 sparse-only**. The
sparse leg's unique contribution is negative. The 6 collision rows and
the query token that pulled each:

| query | row | collision vocab |
| --- | --- | --- |
| dream-plan-runs-actually | drupal/bigpipe-streams-checkout... | checkout |
| budget-reminder-end-of-turn | guestwise/drupal-installs-uid-1... | locked/roles |
| machinae-combat-systems | lywa/lywa-solr-pywsd-runner | runner/enemy |
| machinae-combat-systems | drupal/svg-overlay-swallowed-clicks | clicks/entities |
| machinae-save-restore | lywa/lywa-commerce-phpunit-infra | test/save |
| machinae-threejs-renderer | drupal/bigpipe-streams-checkout... | render |

Full analysis note lives in vault memory
`obsidian-mem-route-attribution-sparse-only-carries-no-unique-relevance.md`.

## Gate definition (what ships)

The sparse route of every recall dispatch only answers rows whose STORED
wake_keywords intersect the stripped query tokens:

```
filter += ` and ARRAY_CONTAINS_ANY(wake_keywords, [<stripped query tokens>])`
```

Semantics, all already proven in-repo:

- The `wake_keywords` column exists per row
  (`packages/service/src/milvus/schema.ts:146`, VARCHAR ARRAY, capacity
  96, element max 64; populated by the indexer from core trigger
  extraction, `indexer.ts:605`).
- `ARRAY_CONTAINS_ANY` + `listLiteral`/`quoteExpr` escaping is already
  used for the exact-section wake gate (`search.ts:374`); reuse those
  helpers. The read-tool and memory_search paths ALREADY gate on
  caller-supplied wakeKeywords; this extends the same discipline to the
  recall-channel BM25 leg.
- Token source: `sparseQueryText` already tokenizes with
  `SPARSE_TOKEN_RUN` and strips `SPARSE_QUERY_STOPWORDS`; refactor it to
  expose the token LIST (keep the string form for the BM25 data field).
  Filter tokens: lower-cased, trimmed, drop len<2, drop len>64 (mirror
  `core/triggers.ts:402` wake-key legality rules), cap at a new exported
  const `SPARSE_WAKE_GATE_MAX_TOKENS = 64` (expression-length guard).
- Fail-open: empty token list ⇒ no gate clause (same family as the
  strip's empty-after-strip fail-open). Rows with EMPTY wake arrays
  can never satisfy `ARRAY_CONTAINS_ANY` and die on this leg; that is
  intended, but pre-flight must count them first (step 1).
- Merge the clause into the existing sparse-side filter expression with
  ` and ` exactly like the other clauses in the builder.
- New exported constants with dated evidence notes citing the A/B
  artifact (house style): `SPARSE_WAKE_GATE_ENABLED = true` (the kill
  switch), and the token cap. Harness imports them from
  `packages/service/lib/search.js` (TASK-008 export pattern; never
  restate values in scripts/eval).

## Step 1: pre-flight measurements (read-only, block on results)

Against the live collection (`.memlite.json` port/pid; never a write):

1. Count rows with empty wake arrays (fetch `wake_keywords` for all
   rows once; count client-side; `ARRAY_LENGTH` filters are unproven on
   lite 3.2.2). If >5% of rows have empty arrays, STOP and fix wake
   extraction (follow-up candidate 1: generic intent markers dominate
   the arrays) before wiring the gate; record counts in this doc.
2. Expected-kill check: for each labeled query, recompute stripped
   tokens, intersect with the stored wake arrays of the 6 forbidden
   rows above; predict which die. A collision row whose wake array
   CONTAINS the collision word will survive the gate: that is wake-list
   pollution, record it (it changes the decision, see Decision rules).
3. zh guard baseline: run
   `node docs/research/probes/zh-analyzer-probe.mjs` (read-only) and
   pin its current hits; zh answers ride maximal-Han-run BM25 and are
   the sparse leg's unique strength.

## Step 2: implement (TDD, single commit with lib)

1. `packages/service/src/search.ts`: pure helper
   `sparseWakeFilterTokens(tokens): string[]` (legality + cap), then
   wire the clause into the sparse side of `dispatchRoutes` behind
   `SPARSE_WAKE_GATE_ENABLED`. Unit tests in
   `packages/service/tests/search.spec.ts`: escaping, cap, empty ⇒ no
   clause, disabled ⇒ no clause.
2. Update the fakes: `service.spec.ts` stub BM25 rows need plausible
   `wake_keywords` arrays or the gate silently drops them (lesson from
   TASK-006, where a stub score silently sat under the new floor).
3. `pnpm build && pnpm test && pnpm lint` green; commit src AND
   `packages/*/lib` (lib IS tracked here).
4. Harness parity (`scripts/eval/recall-eval.mjs`): new `--wake-gate`
   flag mirroring production (pass the SAME filter expression into the
   split-rrf sparse `client.search`; import the constants/helpers from
   the emitted lib; echo the choice in the artifact config block). The
   harness must also be able to run WITHOUT the flag (baseline half).

## Step 3: A/B (same corpus, back to back)

```
node scripts/eval/recall-eval.mjs --mode split-rrf --wake-gate \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 5.0 \
  --rrf-k 60 --top-k 6 --oversample 2 --min-score 0.016129 \
  --out docs/research/eval-split-strip-on-d078-s50-k60-m016129-wakegate.json
```

Baseline = the no-flag run re-executed in the SAME session (corpus
drifts; committed artifacts are not the control). Score the committed
pair by recomputing the class x routes table (the `routes` field per
row; script pattern in the route-attribution vault note):

- PASS: sparse-only forbidden 6 → ≤2, relevant-of-labeled ≥ baseline
  (must not drop below the same-session baseline), zh probe hits
  unchanged, P@k up or forbidden-rate down with the other held.
- Both artifacts + the per-query diff table get committed under
  docs/research/ (timestamp-free), and the outcome is recorded here.

## Step 4: live confirmation (light)

Restart DSH (user action; host code is startup-loaded), verify the
profile bundle carries the gate (grep `SPARSE_WAKE_GATE` in
`~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem/packages/
service/lib/search.js`), then ONE live probe iteration with the
restart-then-launch-first recipe (coding-only first message, protocol
via follow-up; see vault `.INTENTS.md` how-line). Expected: the
think-channel Drupal/npm collision rows stop appearing at turn-start;
machinae/domain rows unaffected.

## Decision rules

- PASS → done; mirror one paragraph into `stopword-strip-findings.md`'s
  FINAL TUNING VALUES block (gate becomes part of the shipped shape).
- PARTIAL → gate wired and correct but some collision rows survive
  because their wake arrays contain the collision word: the real bug is
  wake-keyword EXTRACTION (generic intent markers). File that as its
  own fix (core trigger extraction), re-run Step 1.2 counts after,
  then re-run the A/B. Do NOT escalate to Option 4 from a PARTIAL;
  wake-list hygiene is upstream of it.
- FAIL → relevant rows or zh hits drop: the gate is too blunt. That is
  the ONLY condition that opens Option 4.

## Option 4 (OPTIONAL, gated on FAIL above): dual BM25 fields

Only when a row is genuinely about its collision word in the body text
(gate survived it) yet still irrelevant to the query, tighten WHERE BM25
matches:

1. Schema: add `description_text` VARCHAR + a second `bm25` Function
   producing a second SparseFloatVector `sparse_desc` (from
   `index_description` + `section_header` + wake text, composed at
   index time). Collections are immutable: this means a NEW collection
   and a full reindex; snapshot `~/.dsh/obsidian-mem-db` first; keep
   the old collection alive until the A/B completes (serve/eval flag
   or dbDir swap).
2. Indexer: fill `description_text` per chunk; both sparse vectors are
   function-computed by the server, no client BM25.
3. Dispatch: the sparse leg becomes TWO routes in `dispatchRoutes`;
   fusion variant to evaluate first: a row counts on the sparse side
   only if present in BOTH sparse routes (agreement), then feed one
   sparse rank (best of the two) into the existing RRF(k=60). Do NOT
   add per-leg radii knobs; reuse the client-side floor on both.
4. Harness: new `--mode split-rrf-dual`; A/B as Step 3 with
   baseline = the gated single-sparse run from the SAME session, on an
   identical corpus (both collections built from the same vault state).
5. Costs to state in the results write-up: ~2x BM25 index bytes, one
   full reindex, a third vector field in every row, and one more
   dispatch RPC per search. If it passes, the FINAL TUNING VALUES
   mirror gains a "sparse agreement required" row and the wake gate
   stays (they compose: filter + agreement).

Definition of done: Steps 1-4 recorded with artifacts committed, one
decision (PASS / PARTIAL→wake-extraction fix / FAIL→Option 4) executed,
tree clean, gates green.
