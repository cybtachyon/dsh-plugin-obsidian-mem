# TASK-025 Refactor: service backend pass

Status: done

Review the files touched by the previous 5 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Depends: TASK-020..024. Keep `pnpm build && pnpm test && pnpm lint` green. Commit.

# Resolution (review pass, 2026-11-12)

Scope: the files of the last 7 commits (embedder, milvus launcher/client/ok/schema,
indexer, search, core triggers plus the constants/note/schema changes they ride on).

- **Multiple Sources of Truth** (resolved): scalar column `max_length` lived in both
  `milvus/schema.ts` and the indexer's private clamps, now one core
  `MILVUS_SCALAR_MAX_LENGTHS` record both read (a schema spec asserts the pairing).
  The pinned `consistency_level` literal in schema and search is now core
  `MILVUS_CONSISTENCY_LEVEL`. The 4-chars-per-token heuristic was duplicated in
  `search.ts`; `approxCharsForTokens` in core is now the inverse of `approxTokens`.
  Extension spelling had two normalizers (core extraction, search filters); filters
  now call core `normalizeExtension`, so a filter cannot miss a stored trigger. The
  probe budget (`probeFor` default vs `DEFAULT_PROBE_TIMEOUT_MS`) is one exported
  `PROBE_TIMEOUT_MS`. `MILVUS_ARRAY_CAPACITIES` / `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS`
  were passed around as a pair; `capColumn(values, column)` reads both from one key.
  The refine signature restated core's `Triggers` shape inline; it now uses the type.
- **Duplicate Code** (resolved): three copies of the promise-tail queue (embedder
  `enqueue`, indexer `enqueueOp`/`enqueueWrite`) collapse to `service/serial-queue.ts`;
  three inline `error instanceof Error ? ... : String(...)` renders plus the indexer's
  private `describeError` collapse to `service/errors.ts`; the LLM refinement block
  moves to `service/llm-refine.ts` (`LlmRefiner`: prompt, POST, reply parse, circuit);
  three delete-purge sites share `deleteChunks`/`deleteRows`; the debounce timer block
  appears once (`scheduleFlush`); `dedupe + slice` appears once (`topSections`);
  `withProbe` owns the probe open/channel/close lifecycle in the launcher.
- **Bloaters** (resolved): `VaultIndexer` shed the LLM pass (5 fields and ~90 lines)
  and the per-row assembly (`buildRows`); `processFile` now reads as
  read → hash → archive-diff → chunk → embed → rows → mutation-lane.
- **Data Clumps** (resolved): the row-build group travels as one object;
  the capacity/element-length pair is keyed by column; `IndexerManagerOptions` is
  `Omit<VaultIndexerOptions, 'vault'>` plus `vaults` instead of a hand-copied list.
- **Shotgun Edits** (resolved): a column width or a new Array column now lands in one
  core record (schema + indexer clamps + tests read the same numbers); the consistency
  level and probe budget likewise have one home.
- **Feature Envy** (no action): `search.ts`'s helpers lean on `deps.client`/
  `deps.collectionName`, which is what the injected `SearchDependencies` seam is for;
  wrapping it in a class would add a layer over a two-method client slice.
- **Magic Numbers** (resolved): `RRFRanker(60)` → `RRF_RANKER_K`, `{ ef: 64 }` →
  `DENSE_SEARCH_EF`, `topK * 2` → `CANDIDATE_OVERSAMPLE` (all three were asserted by
  tests while unnamed).
- **Overengineering** (no action): the small injected seams (`IndexerFs`,
  `WatchFactory`, `LlmFetch`, `LiteSpawner`, `ProbeFactory`, `FeatureExtractor`) each
  carry a whole test tier; `IndexerManager` is the aggregate the ui/audit read.

Flagged candidates:

- (a) **Always-on 30 s stat sweep beside the live watcher: kept, now configurable.**
  The sweep is not only the fallback when recursive `fs.watch` is unavailable:
  `nodeWatchFactory` closes its handle on a watcher `error` and nothing re-arms it, so
  without the sweep a long-lived plugin would silently stop indexing. It is stat-only
  (no reads, no embeds, no Milvus calls) and a duplicate sweep is absorbed by the
  content-hash diff. `VaultIndexerOptions.pollIntervalMs` overrides the cadence and
  `0` disables it for callers that want watcher-only triggering; the default is
  unchanged.
- (b) **`Note.raw` stays.** It is one documented additive field that carries the
  frontmatter keys `NoteMeta` deliberately does not model, is produced by the core
  parser that already had them, and is consumed in exactly one place (trigger
  extraction). The alternatives were worse: re-parsing frontmatter in the service adds
  the gray-matter dependency the review asked to avoid; modelling `keywords` /
  `trigger_extensions` / `trigger_frameworks` in `NoteMeta` widens the note contract
  with author vocabulary the audit and tools must then carry, and would change
  `serializeNote`'s byte-stable output. Noted for TASK-033: `serializeNote` writes the
  modelled keys only, so a memory_write that rewrites an authored note must merge
  `note.raw` back in or those override keys are lost.
