# PLAN-obsidian-mem

Objective: Build `dsh-plugin-obsidian-mem`, a DeepSeek Harness (Cordis) TypeScript plugin that
turns Markdown vaults into shared agent memory. Tools: `memory_read`, `memory_search`,
`memory_write`, `memory_dream`, `memory_audit`. Lifecycle hooks inject automatic recall at turn
start, on Read tool calls, and on Think-stream keyword hits; turn end sends the save/audit
reminder. Backend: Milvus-Lite (via @zilliz/milvus2-sdk-node) + @huggingface/transformers
(Xenova/multilingual-e5-small, ONNX q8, passage:/query: prefixes; full 384-d vectors —
e5-small IS 384-d; 768 belongs to e5-base — optional lossy truncation via
vectorDim). Settings
card manages multiple Vaults as "Adopt and Share" or "Read-only".

## Verification guidelines

- `pnpm build` must pass (tsc -b --force, client bundle, verify-emit).
- `pnpm test` (vitest run) and `pnpm lint` (eslint .) must pass; coverage thresholds per vitest config.
- After `plugin_manager install_bundle`, confirm plugin rows with `cordis_inspect_query`
  (Config.listConfigs with name filter; Tool.listTools shows the five memory_* tools).
- Card mount verified via client `Slots.listSubTree` for `plugins.bundle.config`.
- Live smoke: a new session receives turn-start recall injection; `memory_write` rejects
  read-only vaults; Milvus collection exists at `$HOME/.dsh/obsidian-mem-db/`.
- Do not hand-edit profile package.json / cordis.patch.yml; installs go through plugin_manager.

## Open questions (answer before executing tasks marked [Q])

1. [Q1] Milvus-Lite bootstrap: milvus-lite ships as a Python package embedding a Milvus server
   binary. Which bootstrap is acceptable? (a) plugin spawns `milvus-lite server` via uvx/uv
   managed Python on a localhost port, auto-installed on first run; (b) user must pre-install
   milvus-lite (pip/uvx) and plugin only spawns it; (c) connect to an externally managed Milvus
   (docker standalone) with lite spawn as default fallback.
2. [Q2] MRL truncation dimension: multilingual-e5-small is NOT officially MRL-trained; the spec
   asks for truncation to 256 or 384. Which: 384 (safer), 256 (max savings), or full 768?
   Recommend 384.
3. [Q3] wake_keywords / trigger_frameworks extraction ("indexer LLM"): (a) heuristic extraction
   (headers, emphasized terms, code fences, file-extension mentions) with optional LLM upgrade,
   (b) require a user-configured OpenAI-compatible endpoint, (c) use the DSH LLM service if a
   plugin-callable one exists. Recommend (a).
4. [Q4] Dreaming trigger: manual `memory_dream` tool only (audit warns when over budget and the
   agent runs the tool), or also an automatic scheduled/timer trigger. Recommend manual +
   audit-driven instruction (per spec).
5. [Q5] First-run model download: allow downloading Xenova/multilingual-e5-small ONNX (int8,
   ~30 MB) at first use to `$HOME/.dsh/obsidian-mem/models` (env.cacheDir), plus a `scripts/
   prefetch-model.mjs` for offline pre-seed. Confirm acceptable.
6. [Q6] Install: after build+tests pass, install the bundle into the current DSH profile via
   plugin_manager (affects all sessions in this profile) and verify live. Confirm.

## Task index

Dependencies: each phase depends on the previous phase's tasks being complete, except where a
task file lists explicit cross-phase prerequisites.

### Phase 1: Scaffolding

- [x] [TASK-001-pnpm-workspace-scaffold](docs/PLAN-obsidian-mem-TASK-001-pnpm-workspace-scaffold.md)
- [x] [TASK-002-branding-docs](docs/PLAN-obsidian-mem-TASK-002-branding-docs.md)
- [x] [TASK-003-cordis-patch-carrier](docs/PLAN-obsidian-mem-TASK-003-cordis-patch-carrier.md)
- [x] [TASK-004-scaffold-green-build](docs/PLAN-obsidian-mem-TASK-004-scaffold-green-build.md)

### Phase 2: Core domain (packages/core)

- [x] [TASK-010-constants-intents](docs/PLAN-obsidian-mem-TASK-010-constants-intents.md)
- [x] [TASK-011-vault-config](docs/PLAN-obsidian-mem-TASK-011-vault-config.md)
- [x] [TASK-012-memory-note-format](docs/PLAN-obsidian-mem-TASK-012-memory-note-format.md)
- [x] [TASK-013-markdown-chunker](docs/PLAN-obsidian-mem-TASK-013-markdown-chunker.md)
- [x] [TASK-014-workspace-manifest](docs/PLAN-obsidian-mem-TASK-014-workspace-manifest.md)
- [x] [TASK-015-chunk-id-hashing](docs/PLAN-obsidian-mem-TASK-015-chunk-id-hashing.md)
- [x] [Refactor: review Phase 2 files for code risks](docs/PLAN-obsidian-mem-TASK-016-refactor-core.md)

### Phase 3: Embeddings + Milvus backend (packages/service)

- [x] [TASK-020-embedder](docs/PLAN-obsidian-mem-TASK-020-embedder.md)
- [x] [TASK-021-milvus-bootstrap](docs/PLAN-obsidian-mem-TASK-021-milvus-bootstrap.md)
- [x] [TASK-022-collection-schema](docs/PLAN-obsidian-mem-TASK-022-collection-schema.md)
- [x] [TASK-023-indexer-manager](docs/PLAN-obsidian-mem-TASK-023-indexer-manager.md)
- [x] [TASK-024-hybrid-search](docs/PLAN-obsidian-mem-TASK-024-hybrid-search.md)
- [ ] [Refactor: review Phase 3 files for code risks](docs/PLAN-obsidian-mem-TASK-025-refactor-service.md)

### Phase 4: Host service + tools (packages/service, packages/tools)

- [ ] [TASK-030-host-service-config](docs/PLAN-obsidian-mem-TASK-030-host-service-config.md)
- [ ] [TASK-031-tool-memory-read](docs/PLAN-obsidian-mem-TASK-031-tool-memory-read.md)
- [ ] [TASK-032-tool-memory-search](docs/PLAN-obsidian-mem-TASK-032-tool-memory-search.md)
- [ ] [TASK-033-tool-memory-write](docs/PLAN-obsidian-mem-TASK-033-tool-memory-write.md)
- [ ] [TASK-034-tool-memory-audit](docs/PLAN-obsidian-mem-TASK-034-tool-memory-audit.md)
- [ ] [TASK-035-tool-memory-dream](docs/PLAN-obsidian-mem-TASK-035-tool-memory-dream.md)
- [ ] [TASK-036-system-prompt-section](docs/PLAN-obsidian-mem-TASK-036-system-prompt-section.md)
- [ ] [Refactor: review Phase 4 files for code risks](docs/PLAN-obsidian-mem-TASK-037-refactor-tools.md)

### Phase 5: Lifecycle events (packages/events)

- [ ] [TASK-040-session-tracking](docs/PLAN-obsidian-mem-TASK-040-session-tracking.md)
- [ ] [TASK-041-turn-start-recall](docs/PLAN-obsidian-mem-TASK-041-turn-start-recall.md)
- [ ] [TASK-042-read-intercept](docs/PLAN-obsidian-mem-TASK-042-read-intercept.md)
- [ ] [TASK-043-think-intercept](docs/PLAN-obsidian-mem-TASK-043-think-intercept.md)
- [ ] [TASK-044-turn-end-reminder](docs/PLAN-obsidian-mem-TASK-044-turn-end-reminder.md)
- [ ] [TASK-045-global-memory-budget](docs/PLAN-obsidian-mem-TASK-045-global-memory-budget.md)
- [ ] [Refactor: review Phase 5 files for code risks](docs/PLAN-obsidian-mem-TASK-046-refactor-events.md)

### Phase 6: Settings card (packages/client + routes)

- [ ] [TASK-050-host-routes](docs/PLAN-obsidian-mem-TASK-050-host-routes.md)
- [ ] [TASK-051-client-card](docs/PLAN-obsidian-mem-TASK-051-client-card.md)
- [ ] [TASK-052-client-build-pipeline](docs/PLAN-obsidian-mem-TASK-052-client-build-pipeline.md)

### Phase 7: Tests, install, verification

- [ ] [TASK-060-unit-tests](docs/PLAN-obsidian-mem-TASK-060-unit-tests.md)
- [ ] [TASK-061-integration-tests](docs/PLAN-obsidian-mem-TASK-061-integration-tests.md)
- [ ] [TASK-062-install-bundle](docs/PLAN-obsidian-mem-TASK-062-install-bundle.md)
- [ ] [TASK-063-live-verification](docs/PLAN-obsidian-mem-TASK-063-live-verification.md)

## Questionnaire answers (2026-11-12)

- Q1 Milvus-Lite bootstrap: **Auto-spawn via uvx**. Plugin ensures `uv`/`uvx` exists
  (auto-install uv on first run if absent), then spawns `milvus-lite server` bound to a
  localhost port with data under `$HOME/.dsh/obsidian-mem-db/`. Node SDK connects over
  localhost. No user-facing Python install step.
- Q2 Vector dimension: user chose **"768 full"** to avoid lossy MRL truncation, but
  research PROVED multilingual-e5-small is 384-d (768 is e5-base; the original spec's
  "768-dimension output" was wrong). Intent honored: **store the model's full vectors,
  default 384, no truncation**. `vectorDim` knob {128,192,256,320} documented as LOSSY
  truncation (measured ~14% recall@10 loss at 256; model is not MRL-trained), each value
  forces a full re-index. True-768 remains available by switching `model.id` to
  `Xenova/multilingual-e5-base` (bigger download/compute). Flagged to the user.
- Q3 Keyword extraction: **Heuristics always + optional LLM upgrade**. Deterministic
  extraction of wake_keywords/trigger_extensions/trigger_frameworks; a config flag with an
  OpenAI-compatible endpoint adds an LLM pass over new/changed notes.
- Q4 Dreaming: **Split compaction** (user override). Both `memory_dream` and `memory_audit`
  invoke the same compaction process. The settings card gains a Dreaming section where the
  user adds DSH schedule/timer triggers that wake agents to run `memory_dream`. The
  `memory_dream` tool description carries a note that agents can ask the user whether to
  schedule automated dreaming. No plugin-internal timers.
- Q5 Model download: **Runtime download + prefetch script**. transformers.js cacheDir =
  `$HOME/.dsh/obsidian-mem/models`; `scripts/prefetch-model.mjs` for offline pre-seed.
- Q6 Install: **Yes**, install bundle into current profile via plugin_manager and verify
  live (rows active, five tools listed, card mounted, collection created).

## Decision log (post-questionnaire)

- 2026-11-12 **Lazy default vault**: the default shared vault at `$HOME/.dsh/obsidian-mem/`
  is created ONLY at the first moment the plugin needs to access memory (first tool call or
  lifecycle hook that reads/writes memory), never at install/activation. The first memory
  access must notify the agent that a default memory vault is in use and give the full
  path (one-time notice, re-stated by memory_audit). Rationale: the user gets time between
  installing the plugin and their next agent run to set up their own vaults, while
  unconfigured installs still work out of the box. Activation must stay side-effect free
  when no vaults are configured (no vault dirs, no DB, no Milvus child). Implementation
  seam: `service.ensureMemoryAccess()` (idempotent; provisions default vault + .INTENTS.md
  + dbDir + Milvus + collection + indexer on first call and returns a one-time `notice`
  string with the path). Tasks affected: 011, 030..034, 041, 063.
- 2026-11-12 **Live-stack gotchas G10-G13** (discovered by Phase 3A, appended to
  docs/research/milvus-transformers-findings.md; launcher/client code already handles them):
  G10 lite search/query projections OMIT the primary key unless `chunk_id` is listed in
  output_fields (TASK-024 must always include it); G11 SDK keepalive defaults GOAWAY lite's
  Python gRPC server (createMilvusClient pins keepalive channelOptions; never override);
  G12 a client built against a not-yet-listening port never recovers (readiness uses fresh
  probe clients; long-lived client only after ready); G13 cold uvx on empty cache can exceed
  400 s (1.3 GB wheels) — ensureMemoryAccess takes a generous configurable
  readinessTimeoutMs and the ui/status must surface first-run progress, never treat cold >
  90 s as failure. Warm start ~1.5 s.
- 2026-11-12 **Canonical ext patterns adopted** (docs/research/engramory-and-ext-findings.md
  is the dreaming/audit canon): turn-end reminder via `agent/turn-stopping` +
  `agent.steer` with once-per-turn guard (NOT session/event+followup); dreaming =
  single-flight `plan`/`run` orchestrator with editable seeded prompt, `DREAMS.md` diary
  (reserved non-indexed), frontmatter read-stats for bump/degrade (no git-churn); audit
  strictly read-only, bounded/fenced reads, ISSUE-vs-INFO; tool outputs closed `oneOf` by
  `kind` (failures are values); static `inject: []` + scoped `ctx.inject` + reflection
  gateways; one webServer route record per path; system-prompt `interpolate:false`,
  never-throw providers. Tasks 030/031/034/035/036/043/044/050 + AGENTS.md event facts.
- 2026-11-12 **Verified-stack corrections** (docs/research/milvus-transformers-findings.md):
  e5-small is 384-d (spec's "768" was wrong; Q2 intent = no lossy truncation ⇒ default 384;
  `model.id` switch to e5-base is the true-768 path); bootstrap is
  `uvx --with pymilvus --from milvus-lite==3.2.2 milvus-lite server --data-dir <dir>
  --host 127.0.0.1 --port <p>` (no --config-file exists); memory.db is a DIRECTORY in
  lite 3.x (pin version; no migration); model download ~135 MB not ~30; transformers.js
  v4 options `{pooling:'mean', normalize:true, dtype:'q8'}` (`normalization` silently
  ignored); SDK 3.0.6: `hybridSearch` + `data[]` sub-requests, assertOk on every response
  (no throws), explicit BM25 metric_type, `WeightedRanker([w1,w2])`, negative BM25 scores
  ⇒ RRF only, writes serialized in TS, `getLoadState` unreliable ⇒ loadCollectionSync
  after create. Partition-key + ARRAY filters + BM25 Function VERIFIED on lite.
