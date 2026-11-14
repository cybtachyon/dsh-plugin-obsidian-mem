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

## Pre-flight measurements (2026-11-13)

### Step 1.1 empty-wake audit (TASK-001): decision STOP

Probe `docs/research/probes/wake-audit-probe.mjs` (HARD READ-ONLY; the
only RPCs issued are connectPromise, getVersion, count, query) against
the live milvus-lite 3.2.2 (`/home/derek/.dsh/obsidian-mem-db/
.memlite.json`, port 45429, pid 1091813), collection `obsidian_mem`:

| measurement | value |
| --- | --- |
| collection rows (count guard) | 210 |
| rows with EMPTY `wake_keywords` | 39 |
| empty-wake rate | **18.571%** |
| STOP threshold (Step 1.1) | >5% |
| decision | **STOP** (18.571% > 5%) |

39 of 210 rows (18.6%) carry empty wake arrays and could NEVER satisfy
`ARRAY_CONTAINS_ANY(wake_keywords, …)`: the gate as specified silently
kills 18.6% of the corpus on the sparse leg, nearly 4x the 5% ceiling.
Per Step 1.1 and the Decision rules, wake EXTRACTION is fixed first and
this measurement is re-run to a ≤5% rate before any gate is wired;
Step 2 (Phase B) is blocked, and Steps 1.2/1.3 are deferred because
their inputs (stored wake arrays) are exactly what the fix rewrites.

Scan method note: the TASK-prescribed `chunk_id > <last seen>` cursor
paging is unsound on this server. lite 3.2.2 answers `query` in segment
order, not primary-key order, and ACCEPTS AND IGNORES the SDK
`order_by` option (same-day probe: over 210 rows, the first
`chunk_id > -1` limit-200 page returned 200 unordered rows and the
next page `chunk_id > <page max>` matched 0, silently losing 10 rows).
The probe therefore scans chunk_id RANGE WINDOWS (split any window that
answers exactly the limit), and its FINAL line reports `scanComplete:
true` with 210/210 ids collected and cross-checked against the count.

Pollution evidence (TERMS line: 179 distinct wake terms across the
171 non-empty rows; top frequencies):

| term | rows | term | rows |
| --- | --- | --- | --- |
| when | 95 | debug | 9 |
| how | 91 | drupalsettings in drupal 11 js: location, bindings, hydration | 7 |
| why | 82 | not | 5 |
| how to apply | 31 | who | 3 |
| where | 23 | _pvt_, before, dir, every, lywa authorize.net checkout nightwatch test, moduleloader | 2 each |
| what | 20 | 163 further terms | 1 each |

The generic intent markers where/when/why/how/what/how to apply sit at
the very top of the corpus wake vocabulary: these are section-header
labels ("Why:", "How to apply:") harvested by the core trigger
extractor, not content keywords. That is the wake-list pollution the
PARTIAL rule names, confirmed at corpus scale BEFORE wiring the gate.
The tail also carries extraction fragments (for example `+
\`field.field`, `0 of 54`, `2/(k+1`, `attendee chart cropping —
resolved by t9b (2026-11-10`), so the fix must bound wake-key shape,
not just add a stop-list.

Next task (surfaces the STOP): fix wake-keyword EXTRACTION in
`packages/core/src/triggers.ts` so intent-marker headers and extraction
fragments stop entering `wake_keywords`; re-run this probe for ≤5%
empty rows, then resume this spec at Step 1.2.

Fix applied (2026-11-13, commit 376108d): wake legality in
`packages/core/src/triggers.ts` (one home, `isUsableKeyword`) now drops
the generic labels (who/what/when/where/why/how + "how to apply") and
bounds wake-key SHAPE (letter-led; balanced parens/brackets/braces; no
internal em dash), and the note file-name slug words stand as
content wake keywords. Replay of pre-fix vs post-fix extraction over the
indexed vault (143 files, 211 chunks, indexer-identical enumeration):
empty-wake chunks 39 → 0 (18.6% → 0%), generic-label wake entries
347 → 0, fragment-shape terms 27 → 0, distinct terms 179 → 578. The
live reindex + wake-audit re-run that gates Phase B is TASK-015.

### TASK-015 reindex refresh + re-audit (2026-11-13): GATE PASS, Phase B unblocked

The live collection was reindexed through the indexer's own code path by
`scripts/live-reindex.mjs` (new, durable): a standalone driver built the
way `scripts/eval/recall-eval.mjs` builds its stack (on-disk
`packages/*/lib` = post-376108d code, live `{port,pid}` from
`.memlite.json`, real embedder, registry replayed through the service's
own config defaults + `vaults.json`), then `IndexerManager.reindexAll()`.
The forced re-diff runs through the indexer's documented `IndexerFs`
seam (the in-memory state copy's `contentHash` fields are shadowed to
zero at construction; chunkIds preserved, so every file still executes
the indexer's own delete-old-ids → insert-fresh-rows pair). No state
file was deleted or hand-edited, no raw upsert/delete/DDL, no
drop/rebuild, dim and model unchanged. The LLM refiner never engaged:
the script omits the `llm` option, so the codebase's disabled-by-default
`LlmRefiner` (heuristics only) runs; the script refuses to run if the
mounted config ever enables it. Run summary: 125 files re-embedded +
inserted, 19 archived/empty notes settled, 0 errors, 213 → 213 rows.

Re-run of `docs/research/probes/wake-audit-probe.mjs` (HARD READ-ONLY,
chunk_id range-split windows) against the post-reindex collection:

| measurement | value |
| --- | --- |
| collection rows (count guard) | 213 |
| rows collected (scanComplete) | 213/213 |
| rows with EMPTY `wake_keywords` | 0 |
| empty-wake rate | **0.000%** |
| STOP threshold (Step 1.1) | >5% |
| decision | **no-STOP** (0% ≤ 5%) |

Pollution re-check: a second read-only full scan counted the generic
intent markers over all 213 rows: `who/what/when/where/why/how/`how to
apply` = **0 occurrences corpus-wide** (pre-fix: when 95, how 91, why
82). TERMS (585 distinct terms, top 20):

| term | rows | term | rows |
| --- | --- | --- | --- |
| drupal11 | 22 | checkout | 12 |
| mem | 20 | before | 11 |
| obsidian | 20 | debug | 10 |
| test | 17 | drush | 10 |
| lywa | 16 | api | 9 |
| config | 15 | entity | 9 |
| kernel | 15 | is | 9 |
| dsh | 14 | the | 9 |
| guestwise | 13 | bigpipe | 8 |
| not | 13 | drupalsettings | 8 |

The top-20 is content vocabulary (file-slug words standing per
TASK-014); the only residue is a few ordinary function words (`not`,
`before`, `is`, `the`) carried by file-name slugs and content tokens,
which `isUsableKeyword` bounds by shape, not by a stop-list. Not a gate
concern.

Reconciled count: the fresh post-reindex number is the truth: **213 live
rows == 213 chunk ids in the indexer state file (144 files)**. The live
side moved since the TASK-001 audit (210): notes recorded into the vault
after the audit were indexed by the host's watchers (the
milvus-lite-pagination note at +2 chunks took the TASK-014 replay's
143-file/211-chunk vault to today's 144/213); the pre-reindex live count
already read 213, so the reindex itself changed no row count, only wake
content. No mid-run rowCount drift (213 before, 213 after, 213 at audit).

**Decision: GATE PASS (0% ≤ 5%, markers absent from TERMS) — Phase B
unblocked; resume this spec at Step 1.2.**

### Step 1.2 expected-kill check (TASK-002): 5/6 collision rows die, 1 survives

Probe `docs/research/probes/wake-kill-check-probe.mjs` (HARD READ-ONLY;
the only RPCs issued are connectPromise, getVersion, count, query over
chunk_id range-split windows) against the post-reindex collection.
Measured state confirmed in-probe before any prediction: 213 rows,
scanComplete 213/213, EMPTY wake rows 0, generic intent markers
`who/what/when/where/why/how/`how to apply` = 0 occurrences corpus-wide
(the same full scan carries this INVARIANT line, so the check cannot
silently run on a re-polluted collection).

Method: the 6 collision rows are derived at run time from
`eval-split-strip-on-d078-s50-k60-m016129.json` (`routes: "sparse"`,
`classification: "F"`, cross-checked against this §Problem table; all 6
artifact chunk_ids still live). Per labeled query the token list is
`sparseQueryText(query)` (imported from
`packages/service/lib/search.js`) split on its single-space join, then
the shipped gate's filter-token legality (lower-case, trim, len 2..64,
cap 64); the raw split is tallied too and every verdict agrees between
the two forms. Prediction per row: survives iff tokens ∩ stored
`wake_keywords` ≠ ∅ (`ARRAY_CONTAINS_ANY` semantics).

| query | row source_path (§section) | collision word | wake contains word? | tokens ∩ wake | predicted |
| --- | --- | --- | --- | --- | --- |
| dream-plan-runs-actually | drupal/bigpipe-streams-checkout-before-drupalsettings.md (drupalSettings…hydration) | checkout | **yes** | — | dies |
| budget-reminder-end-of-turn | guestwise/drupal-installs-uid-1-has-no-global-roles-group-locked-entities-403-for-it.md | locked, roles | **yes, yes** | global | **survives** |
| machinae-combat-systems | lywa/lywa-solr-pywsd-runner.md | runner, enemy | **runner yes**, enemy no | — | dies |
| machinae-combat-systems | drupal/svg-overlay-swallowed-clicks.md | clicks, entities | **clicks yes**, entities no | — | dies |
| machinae-save-restore | lywa/lywa-commerce-phpunit-infra.md (Lywa commerce PHPUnit…) | test, save | no, no | — | dies |
| machinae-threejs-renderer | drupal/bigpipe-streams-checkout-before-drupalsettings.md (…› _wrapper_format…) | render | no | — | dies |

Wake-list pollution call-outs (row wake array CONTAINS its §Problem
collision word): rows 1–4, per the stored arrays (file-name slug words
standing as wake keywords is the intended TASK-014 design):

| row | stored wake_keywords |
| --- | --- |
| bigpipe §hydration | `bigpipe, streams, checkout, before, drupalsettings, debug` |
| guestwise drupal-installs | `drupal, installs, uid, has, no, global, roles, group, locked, entities, for, it` |
| lywa-solr-pywsd-runner | `lywa, solr, pywsd, runner` |
| drupal-svg-overlay-swallowed-clicks | `svg, overlay, swallowed, clicks, debug` |
| lywa-commerce-phpunit-infra | `lywa, commerce, phpunit, infra, dir` |
| bigpipe §_wrapper_format | `bigpipe, streams, checkout, before, drupalsettings, drupalsettings in drupal 11 js: location, bindings, hydration, twice, last` |

But pollution of the PARTIAL rule's kind (a collision word that keeps
the row alive under the gate) is only row 2, and its survival is not
even through its named collision words: `locked`/`roles` are not
stripped tokens of the budget query, the surviving intersection is the
slug word `global` ("Update the **global** memory budget reminder…" ∩
slug "…has-no-**global**-roles…"). That is a genuine shared-vocabulary
collision the gate cannot remove without deleting legitimate slug
signal; wake hygiene has no lever here. Rows 1, 3, 4 carry their
collision word in wake but the word is not a stripped token of the
pulling query, so the gate still kills them. Observation for the §Problem
table: its vocab column is row-side collision vocab, not stripped query
tokens in 8 of its 10 listed words (only `enemy`, `save` are query
stripped-tokens); the prediction above uses the full token ∩ wake
intersection, which subsumes the vocab column.

Relevant-row safety (the PASS rule "relevant-of-labeled ≥ baseline"):
of the 15 artifact relevant rows visible on the sparse leg
(`routes: sparse|both`), 14 are predicted to survive the gate:
budget-reminder-end-of-turn (global, budget, not),
lib-tracked-build-contract ×2 (lib, build, clean), typecheck-test-trees
(6 shared tokens), session-transcript-probe (session, transcript,
probe), subagent-zero-recall ×2 (6 shared tokens),
layout-sidecar-model-cache (vault), machinae-combat-systems and
machinae-threejs-renderer (typescript-simulation-style.md ×2, via
`simulation`), lywa-synonym-service-di 1 of 2 chunks (`protected`),
lywa-lightbox-pause ×2 (gallery, lightbox3), guestwise-ci-playwright
(ci). The one predicted die, lywa-synonym-service-di chunk 61300563937
24780 (`drupal/drupal11-entity-form-di.md`, wake `drupal11, entity,
form, di`): none of the four words is a stripped query token (the
query writes `EntityTypeManager` as one token, and says "dependency
injection", not `di`), and the row rode `routes: "both"`, so its dense
leg still carries it onto the page; relevant-of-labeled is predicted
intact.

**Prediction for the Step 3 A/B (to compare against TASK-011):
sparse-only forbidden 6 → 1 (row 2 survives; ≤2 stays inside the PASS
margin), relevant sparse-visible rows 15 → 14 with the loser still
dense-carried, no marker-driven survivors.** A TASK-011 outcome of
survivors >1 or relevant loss contradicts this prediction and points at
harness/gate wiring, not at wake content.

### Step 1.3 zh baseline (TASK-003): the zh control pin for the TASK-010/011 A/B

Probe `docs/research/probes/zh-analyzer-probe.mjs` run UNCHANGED (the
`--wake-gate` flag ships in TASK-007; not used here), HARD READ-ONLY (the
only RPCs issued are connectPromise, getVersion, count, query, search)
against the live post-reindex milvus-lite 3.2.2. Invariants verified in
the same session before pinning: `wake-audit-probe.mjs` FINAL line 213
rows, scanComplete 213/213, EMPTY wake rows 0 (0.000%, no-STOP), and a
companion read-only `ARRAY_CONTAINS_ANY(wake_keywords,
["who","what","when","where","why","how","how to apply"])` query matched
0 rows (intent markers 0 corpus-wide). No live-reindex repair was needed.
The probe's BOOT and SUMMARY lines independently read `rowCount: 213`.

**This is the TASK-011 comparison control.** TASK-010 (baseline half)
expect its zh hits equal to this pin; TASK-011 (gated run) is scored
against it by the "zh probe hits unchanged" PASS criterion. SUMMARY line
pinned verbatim:

```json
{"probe":"SUMMARY","server":{"status":{"extra_info":{},"error_code":"Success","reason":"","code":0,"retriable":false,"detail":""},"version":"milvus_lite-3.2.2"},"rowCount":213,"shippedStripText":"智能体的共享记忆","hits":[{"probe":"raw-joined","text":"智能体的共享记忆","hitChunkIds":[]},{"probe":"t002-strip-out","text":"智 能 体 享 记 忆","hitChunkIds":["5384054551459882"]},{"probe":"split-unstripped","text":"智 能 体 的 共 享 记 忆","hitChunkIds":["5384054551459882","2725569707718867","266388258919095"]},{"probe":"cp-智","text":"智","hitChunkIds":[]},{"probe":"cp-能","text":"能","hitChunkIds":[]},{"probe":"cp-体","text":"体","hitChunkIds":[]},{"probe":"cp-共","text":"共","hitChunkIds":[]},{"probe":"cp-享","text":"享","hitChunkIds":[]},{"probe":"cp-记","text":"记","hitChunkIds":["5384054551459882"]},{"probe":"cp-忆","text":"忆","hitChunkIds":["5384054551459882"]},{"probe":"cp-的","text":"的","hitChunkIds":["5384054551459882","2725569707718867","266388258919095"]},{"probe":"run-记忆","text":"记忆","hitChunkIds":["5384054551459882","2725569707718867"]},{"probe":"run-智能体","text":"智能体","hitChunkIds":["5384054551459882","2725569707718867"]},{"probe":"run-的共享记忆","text":"的共享记忆","hitChunkIds":["2725569707718867","5384054551459882"]},{"probe":"substr-共享记忆","text":"共享记忆","hitChunkIds":[]},{"probe":"shipped-strip-out","text":"智能体的共享记忆","hitChunkIds":[]}]}
```

Han-bearing chunks: both LOCATE lines (`记忆`, `智能体`) return the same
two rows, `2725569707718867`
(`chinese-copy-plugin-description-grammar-rules.md`) and
`5384054551459882` (`stopword-3-1-5-api-shape-and-zh-list-limits.md`).
A third chunk id appears in the SUMMARY hit union: `266388258919095`, a
second chunk of the same stopword file, reached only through the
standalone `的` token (`cp-的`, `split-unstripped`); a companion
read-only `chunk_text like "%的%"` query returned exactly these three
rows. The probe docblock's "exactly two Han-bearing chunks" is the
LOCATE pair strictly: three chunks carry Han text, only two carry Han
words.

Wake arrays of the Han-hitting chunks (read-only `chunk_id in […]`
query; the two same-file chunks store identical arrays):

| chunk_id | source_path | wake_keywords | Han-containing wake entries |
| --- | --- | --- | --- |
| 2725569707718867 | chinese-copy-plugin-description-grammar-rules.md | chinese, copy, plugin, description, grammar, rules | none |
| 5384054551459882 | stopword-3-1-5-api-shape-and-zh-list-limits.md | stopword, api, shape, and, zh, list, limits | none |
| 266388258919095 | stopword-3-1-5-api-shape-and-zh-list-limits.md (2nd chunk) | stopword, api, shape, and, zh, list, limits | none |

**Observation, the gate's predicted zh impact (recorded for
TASK-010/011):** none of the three Han-hitting chunks' wake arrays
contains ANY Han run; wake extraction harvests Latin file-name-slug
words here. The zh query tokens the gate checks are sparseQueryText's
maximal Han runs, so with the shipped filter-token legality (drop
len<2, drop len>64, empty list ⇒ no clause ⇒ fail-open) the gated run
is predicted to differ from this control on exactly three probes:
`run-记忆`, `run-智能体`, `run-的共享记忆` (gated Han tokens of length
2, 3, 5; wake ∩ tokens = ∅ ⇒ 2 hits → 0 each). Every single-codepoint
shape (`t002-strip-out`, `split-unstripped`, `cp-记`, `cp-忆`, `cp-的`;
`的` is also a zho stopword) gates to an empty token list and fails
open, keeping its control hits; the already-empty rows (`raw-joined`,
`substr-共享记忆`, `shipped-strip-out`) stay empty. If TASK-011's gated
run reproduces this, the loss of the three maximal-run probes is the
Decision rules' named FAIL condition ("zh hits drop") realized as
predicted, and the root cause is wake extraction emitting no Han wake
keys, not gate wiring.

### Han wake keys (TASK-017): the §Step 1.3 gap repaired, gate re-verified for zh

Q4 answer (2026-11-13): "Fix wake extraction to emit Han wake keys
first", then wire the gate per the spec unchanged. Landed in core
commit 68e4a02 (`packages/core/src/triggers.ts` + rebuilt lib +
`tests/triggers.spec.ts`, 7 new tests): the chunk text's maximal
`[\p{Script=Han}]+` runs are harvested as wake candidates after every
existing entry, flowing through the same ONE legality gate
(`isUsableKeyword`, which gained the whole-run noise rule: a candidate
made entirely of standalone Han function-word characters drops, the
analyzer strip's rule mirrored with a 26-char core-local list, no
stopword import into core; single chars die at the length-2 floor).
Element cap 64 and column capacity 96 unchanged; Latin wake arrays are
byte-unchanged (a pinned collision-row-shape test). Gate: `pnpm build
&& pnpm test && pnpm lint` green (840 passed).

Live refresh (`node scripts/live-reindex.mjs`, the only write path):
125 files indexed (every non-archived file re-embedded and inserted),
19 purged (archived/removed files, idempotent, zero rows dropped), 0
errors; 213 rows before == 213 after == 213 state chunk ids.
Wake-audit re-run: FINAL 213 rows, scanComplete 213/213, EMPTY wake
rows 0 (0.000%, no-STOP), intent-marker `ARRAY_CONTAINS_ANY` query 0
rows (markers 0 corpus-wide), TERMS distinct 602 (top Latin: drupal11
22, mem 20, obsidian 20, test 17, lywa 16, config 15, kernel 15, dsh
14…). TERMS top-40 carries no Han (Han terms sit at 1–2 rows each);
the full-scan Han vocabulary is recorded here instead — 2 rows carry
Han wake keys, 17 distinct Han terms: 智能体 2, 的共享记忆 2, 记忆 2,
允许 1, 允许你 1, 共享 1, 共享智能体 1, 可将你的 1, 可将您的 1, 它允许
1, 插件 1, 是一款 1, 智能体记忆 1, 知识库用作 1, 知识库用作智能体 1,
自己 1, 自己的 1.

The three §Step 1.3 chunks' post-refresh wake arrays (verbatim):

| chunk_id | source_path | wake_keywords |
| --- | --- | --- |
| 2725569707718867 | chinese-copy-plugin-description-grammar-rules.md | chinese, copy, plugin, description, grammar, rules, 是一款, 插件, 可将你的, 知识库用作智能体, 的共享记忆, 可将您的, 知识库用作, 它允许, 允许, 允许你, 共享智能体, 记忆, 共享, 智能体记忆, 智能体, 自己, 自己的 |
| 5384054551459882 | stopword-3-1-5-api-shape-and-zh-list-limits.md | stopword, api, shape, and, zh, list, limits, 记忆, 智能体, 的共享记忆 |
| 266388258919095 | stopword-3-1-5-api-shape-and-zh-list-limits.md (2nd chunk) | stopword, api, shape, and, zh, list, limits |

Chunk 266388258919095 stores no Han by design: its only Han content is
the standalone 的 地 得 和 list illustration, dropped by the length-2
floor and the function-run rule.

**zh gate PREVIEW (read-only, throwaway script, not the TASK-007
flag):** for each Han-bearing probe text, BM25 search (production
sparse shape, limit 12) with and without
`ARRAY_CONTAINS_ANY(wake_keywords, [<maximal-run token>])`, the
expression the gate will emit; tokens are the probe texts themselves
(all pass the len 2–64 filter-token legality):

| probe | gate token | ungated hits | gated hits | lost |
| --- | --- | --- | --- | --- |
| run-记忆 | 记忆 | 5384054551459882, 2725569707718867 | 5384054551459882, 2725569707718867 | none |
| run-智能体 | 智能体 | 5384054551459882, 2725569707718867 | 5384054551459882, 2725569707718867 | none |
| run-的共享记忆 | 的共享记忆 | 2725569707718867, 5384054551459882 | 2725569707718867, 5384054551459882 | none |
| shipped-strip-out | 智能体的共享记忆 | (empty) | (empty) | none |

**Survival check (the key risk, verified not assumed):** the probes
query SUBSTRINGS (记忆, 智能体) while wake stores MAXIMAL RUNS. Exact
maximal-run matching survives every probe on this corpus because each
queried substring ALSO appears as a standalone maximal run somewhere
in each Han-bearing chunk's own text (e.g. `共享智能体（Agent）记忆`
and `智能体（Agent）的共享记忆` split at the full-width parens; the
`智能体的共享记忆` README string never occurs unbroken, matching the
pin's own 0 hits for that shape). The design limit stays: a future
zh note whose text only ever embeds a substring inside a longer run
stores no substring key, and a gate probe of that substring still
dies — the CJK carve-out Q4 rejected, unchanged by this task. The
TASK-017 STOP condition (any run-* probe dying in preview) did NOT
fire.

**Verdict: Han wake keys live, gate safe for zh.** The §Step 1.3
prediction (three probes 2→0) is superseded for TASK-010/011: after
this refresh the pinned control's three run-* probes are predicted to
survive the gate UNCHANGED. Phase B (spec Step 2) is unblocked.

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
