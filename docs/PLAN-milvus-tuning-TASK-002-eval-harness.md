# TASK-002: Offline eval harness

- [x] Complete. Harness: `scripts/eval/recall-eval.mjs` (query/label set:
  `scripts/eval/queries-labels.mjs`; knob + label docs:
  `scripts/eval/README.md`).

Build a standalone measurement harness that replays realistic queries
against the LIVE production milvus-lite server, read-only.

Scope:
1. Connect via the running server's address (read port/pid from
   `/home/derek/.dsh/obsidian-mem-db/.memlite.json`; channelOptions
   keepalive pin per the stack-traps note). Never write to the production
   collection.
2. Replicate the production dispatch faithfully (docs/research/
   milvus-transformers-findings.md §4.2 invariants: `data[]` routes,
   per-route metric_type, per-route expr, G10 projection, ef=64, limit ×
   CANDIDATE_OVERSAMPLE, RRFRanker(k)); the dense query vector comes from
   the production embedder (packages/service lib embedder, e5-small int8
   with `query:` prefix) so scores match production.
3. All knobs parameterizable from the CLI: dense radius/range_filter,
   sparse radius, RRF k, reranker kind (RRF/Weighted), post-RRF minScore.
4. Query set (>= 10 queries): (a) real turn-start queries harvested from
   recent session transcripts (`~/.dsh/sessions/.../session.v4.jsonl.zstd`,
   per the dsh-session-transcript-probe note); (b) representative work
   queries for this repo, machinae-game, and an unrelated project
   (guestwise) to expose cross-project noise. Label each query with
   expected-relevant sources (path + section) and known-irrelevant
   sources that currently pollute (guestwise/lightbox/etc. notes).
5. Metrics per query at topK=6: relevant-in-page count, irrelevant count
   (noise), relevant-missed count; plus aggregate precision@k and recall
   of labeled relevant. Emit a table + JSON (commit the JSON schema, not
   necessarily results).

Definition of Done: harness script lives in the repo (suggested
`scripts/eval/recall-eval.mjs` or `docs/research/`), runs green against the
live server printing the metrics table, and its README section documents
the knob flags. Committed. No production src change.
