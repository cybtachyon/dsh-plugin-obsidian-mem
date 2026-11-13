# TASK-001: Radius semantics probe

- [x] Complete. Findings: `docs/research/radius-tuning-findings.md`;
  runnable probe: `docs/research/probes/radius-probe.mjs`.

Verify range-search parameter semantics on the exact stack (milvus-lite
3.2.2, @zilliz/milvus2-sdk-node 3.0.6) before any production code change.

Scope (per answer A2: NO scratch instance; read-only searches against the
live production collection on the running server only):
1. Connect to the live milvus-lite server (port from
   `/home/derek/.dsh/obsidian-mem-db/.memlite.json`; channelOptions
   keepalive pin per the stack-traps note). Never issue a write, delete,
   createIndex, load, or release against the production collection.
2. Probe with the node SDK, recording raw behavior:
   - dense `search` with `params: { radius: 0.78 }` only;
   - dense with `params: { radius: 0.78, range_filter: 1.0 }`;
   - whether radius is exclusive/inclusive at the boundary;
   - sparse (BM25 metric) `search` with `params: { radius: 2.5 }`;
   - sparse with `radius` + `range_filter`; whether lite rejects radius on
     the BM25 sparse route (capture the exact error if so);
   - both routes inside `hybridSearch` `data[]` sub-requests with per-route
     `params` carrying radius (the exact dispatchHybrid shape);
   - interaction with `limit` and with `ef` on the dense route.
3. Leave the probe as a runnable script (suggested
   `docs/research/probes/radius-probe.mjs`, reading the port from the
   .memlite.json file) and record findings verbatim in
   `docs/research/radius-tuning-findings.md`.

Definition of Done: findings doc names, with probe output evidence, the
exact param spelling/type (number vs string) accepted for radius and
range_filter on BOTH routes in hybridSearch, boundary inclusivity, and any
rejection that forces an alternative (e.g. client-side cutoff). Committed
(probe script + findings doc only, no src change).
