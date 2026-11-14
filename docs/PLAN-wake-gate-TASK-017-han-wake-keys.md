# TASK-017: Han wake-key harvest (core triggers.ts) + re-verify zh gate preview

Inserted by the Q4 user answer (2026-11-13): "Fix wake extraction to
emit Han wake keys first", then wire the gate per the spec unchanged.
This is the LAST blocker before Phase B; the A/B corpus must carry Han
wake keys when the gate ships, or the documented zh PASS criterion
fails by construction (TASK-003, spec §Step 1.3: the three Han-hitting
chunks store zero Han wake keys today).

1. Read `packages/core/src/triggers.ts` (post-376108d), the two
   Han-bearing vault notes BY PATH (not via memory tools):
   `/home/derek/.dsh/obsidian-mem/chinese-copy-plugin-description-grammar-rules.md`,
   `/home/derek/.dsh/obsidian-mem/stopword-3-1-5-api-shape-and-zh-list-limits.md`,
   and the settled analyzer rule (sparseQueryText docblock in
   packages/service/src/search.ts: MAXIMAL HAN RUNS on both index and
   query sides; a Han run is noise only when the whole run is a zho
   list entry like standalone 的/和/时).
2. Design the minimal bounded harvest in the SAME one-home legality
   (`isUsableKeyword`): extract maximal Han runs from the text the
   extractor already sees per chunk (heading/bold/body inputs already
   in TriggerInput), matching `[\p{Script=Han}]+` maximal runs; drop
   runs that are whole standalone function-word characters (small
   core-level list mirroring the strip's rule; do NOT import the
   service's stopword lists into core); keep length/word-count legality
   (Han runs pass as 1-word keys; cap length at the schema element
   max). Order: existing wake entries first, Han runs fill the
   column's capacity (MILVUS_ARRAY_CAPACITIES.wakeKeywords), deduped.
   No new vocabulary sources beyond the chunk's own text.
3. TDD in the core triggers spec: Han run extraction shape, standalone
   function-run drop, cap/interaction with existing entries, Latin-only
   notes unchanged (collision-row wake arrays must NOT change).
4. GATES + COMMIT like TASK-014 (src + rebuilt core lib + spec; prek;
   porcelain check; no attribution).
5. Live refresh + verification (reads follow the RPC allow-list; the
   only writes go through scripts/live-reindex.mjs):
   a. `node scripts/live-reindex.mjs`;
   b. wake-audit re-run: 0 empty, markers 0, TERMS now contains Han
      runs (record top terms + the Han terms);
   c. zh gate PREVIEW (read-only, throwaway script OK): for each zh
      probe text with Han content (run-记忆, run-智能体,
      run-的共享记忆, plus shipped-strip-out), run the BM25 search with
      `expr: ARRAY_CONTAINS_ANY(wake_keywords, [<the maximal-run token>])`
      exactly as the gate will, and record surviving chunk ids.
      EXPECTATION: run-* probes keep their hits. This is a preview, not
      the production flag (TASK-007 adds that).
6. RECORD in spec §Step 1.3 (or a §"Han wake keys" subsection): whether
   exact maximal-run matching survives each probe. KEY RISK to verify,
   not assume: the probe queries SUBSTRINGS (记忆, 智能体) while wake
   stores MAXIMAL RUNS; a note whose text only ever contains
   智能体的共享记忆 as one run will NOT store 记忆 as an element, and
   that probe still dies. If any run-* probe still dies in preview,
   STOP after recording the exact wake arrays + texts, and report to
   the parent (do NOT widen scope unilaterally; the fallback is the
   CJK carve-out decision Q4 rejected).
7. Commit doc/verification updates alongside.

Definition of Done: core fix + lib + tests committed; live collection
refreshed; wake-audit + zh preview numbers recorded in the spec doc;
verdict line "Han wake keys live, gate safe for zh" (or the STOP
report). Phase B is next.
