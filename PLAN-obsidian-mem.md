# PLAN-obsidian-mem

Objective: Build `dsh-plugin-obsidian-mem`, a DeepSeek Harness (Cordis) TypeScript plugin that
turns Markdown vaults into shared agent memory. Tools: `memory_read`, `memory_search`,
`memory_write`, `memory_dream`, `memory_audit`. Lifecycle hooks inject automatic recall at turn
start, on Read tool calls, and on Think-stream keyword hits; turn end sends the save/audit
reminder. Backend: Milvus-Lite (via @zilliz/milvus2-sdk-node) + @huggingface/transformers
(Xenova/multilingual-e5-small, ONNX int8, passage:/query: prefixes; full 768-d vectors by
default, optional truncation via vectorDim). Settings
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

- [ ] [TASK-001-pnpm-workspace-scaffold](docs/PLAN-obsidian-mem-TASK-001-pnpm-workspace-scaffold.md)
- [ ] [TASK-002-branding-docs](docs/PLAN-obsidian-mem-TASK-002-branding-docs.md)
- [ ] [TASK-003-cordis-patch-carrier](docs/PLAN-obsidian-mem-TASK-003-cordis-patch-carrier.md)
- [ ] [TASK-004-scaffold-green-build](docs/PLAN-obsidian-mem-TASK-004-scaffold-green-build.md)

### Phase 2: Core domain (packages/core)

- [ ] [TASK-010-constants-intents](docs/PLAN-obsidian-mem-TASK-010-constants-intents.md)
- [ ] [TASK-011-vault-config](docs/PLAN-obsidian-mem-TASK-011-vault-config.md)
- [ ] [TASK-012-memory-note-format](docs/PLAN-obsidian-mem-TASK-012-memory-note-format.md)
- [ ] [TASK-013-markdown-chunker](docs/PLAN-obsidian-mem-TASK-013-markdown-chunker.md)
- [ ] [TASK-014-workspace-manifest](docs/PLAN-obsidian-mem-TASK-014-workspace-manifest.md)
- [ ] [TASK-015-chunk-id-hashing](docs/PLAN-obsidian-mem-TASK-015-chunk-id-hashing.md)
- [ ] [Refactor: review Phase 2 files for code risks](docs/PLAN-obsidian-mem-TASK-016-refactor-core.md)

### Phase 3: Embeddings + Milvus backend (packages/service)

- [ ] [TASK-020-embedder](docs/PLAN-obsidian-mem-TASK-020-embedder.md)
- [ ] [TASK-021-milvus-bootstrap](docs/PLAN-obsidian-mem-TASK-021-milvus-bootstrap.md)
- [ ] [TASK-022-collection-schema](docs/PLAN-obsidian-mem-TASK-022-collection-schema.md)
- [ ] [TASK-023-indexer-manager](docs/PLAN-obsidian-mem-TASK-023-indexer-manager.md)
- [ ] [TASK-024-hybrid-search](docs/PLAN-obsidian-mem-TASK-024-hybrid-search.md)
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
- Q2 Vector dimension: **768 full** (user override of the spec's MRL truncation). Keep a
  `vectorDim` config knob (256/384/768) for future re-index, default 768. No slicing of
  embeddings by default.
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
