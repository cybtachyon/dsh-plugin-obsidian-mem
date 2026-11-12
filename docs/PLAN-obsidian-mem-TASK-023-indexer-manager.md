# TASK-023 Indexer manager (vault watchers → Milvus)

Depends: TASK-013, TASK-015, TASK-022. `packages/service/src/indexer.ts`.

## Scope

- Per-vault index state in `<vault>/metadata/obsidian-mem-state.json`:
  `{ version, files: { rel: { contentHash, mtimeMs, chunkIds[] } } }` (atomic write:
  tmp+rename).
- `reindexVault(vault)`: walk `markdown/**/*.md` (skip dotfiles, `.INTENTS.md`,
  non-indexed list, frontmatter `archive: true` notes — archived chunks deleted);
  diff by contentHash → changed/new/removed; pipeline per file: parse frontmatter →
  chunker → trigger extraction (heuristics: extensions from fenced-block languages +
  inline file paths + `trigger_extensions:` frontmatter override; frameworks from
  frontmatter + known-framework vocabulary + workspace-manifest vocabulary; wake_keywords
  from headers, **bold/emphasis**, frontmatter `keywords:`, intent-marker words present)
  → scope from frontmatter `type` → embedPassages → delete stale chunk_ids → insert.
- Optional LLM pass (Q3): config `llm { enabled, baseUrl, model, apiKeyEnv }` → chat
  completion extracts `{wake_keywords, trigger_frameworks}` per chunk; failure falls back to
  heuristics; never blocks indexing.
- Triggers: activation full-scan (background, non-blocking), per-vault debounced
  fs.watch (recursive where available, 30s polling fallback; debounce 1500 ms per memsearch
  watchdog, watch for duplicate events), manual `reindexAll()`
  (used by card + audit), write-through single-file reindex hook for memory_write.
- Cap: max files per vault, max chunks per file, embed batch 32 (memsearch measured
  throughput plateau); progress counters exposed
  for status (`indexed/pending/errors`) consumed by ui + audit.
- Milvus offline → queue dirty state, retry on next activation (state file diff covers it).

## DoD

Tests with fake embedder + fake milvus client (insert/delete payloads, archived skip,
watcher debounce via fake timers, LLM fallback); commit.
