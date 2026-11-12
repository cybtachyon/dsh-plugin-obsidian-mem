# TASK-010 Domain constants and intent markers

Depends: TASK-004. Lives in `packages/core/src/constants.ts` (+ index re-export).

## Scope (codify as exported constants)

- `INTENT_MARKERS`: who, what, when, where, how, why, investigate, debug, troubleshoot.
- `SCOPE_GLOBAL='global'`, `SCOPE_DOMAIN='domain'`, `SCOPE_REFERENCE='reference'`; project
  scope is a slug string ("{{project-name}}") validated by `isScopeSlug()`.
- Vault layout: subdirs `markdown/` and `metadata/`; reserved non-indexed file
  `INTENTS_FILE='.INTENTS.md'` at vault root (spec says "in the first Shared vault";
  constant for the filename only).
- Default paths (functions, not constants, since they read $HOME): `defaultVaultPath()` =
  `$HOME/.dsh/obsidian-mem`, `dbDir()` = `$HOME/.dsh/obsidian-mem-db`, `dbFile()` =
  `dbDir()/memory.db`, `modelCacheDir()` = `$HOME/.dsh/obsidian-mem/models`,
  stateDir() = dbDir()/state.
- `RECALLED_OPEN(source)` / `RECALLED_CLOSE` helpers producing
  `<recalled_memory source="/abs/path">` ... `</recalled_memory>` wrappers.
- Tool names: `memory_read|memory_search|memory_write|memory_dream|memory_audit`.
- Budget defaults (overridable via plugin Config): turn-start recall tokens (e.g. 1200),
  read-intercept per-section tokens 350 and sections 2, global-memory injection tokens 1500,
  search default topK 6, maxResults cap 20, chunk maxTokens 500. Approximate tokens =
  `Math.ceil(chars/4)` helper `approxTokens()`.
- Milvus collection name `obsidian_mem`; field names (chunk_id, source_path, section_header,
  chunk_text, vault, scope, trigger_extensions, trigger_frameworks, wake_keywords,
  dense_vector, sparse as BM25 output if enabled, updated_at); default vectorDim 768 with
  allowed {256,384,768}.
- Embedding constants: model id `Xenova/multilingual-e5-small`, `PASSAGE_PREFIX='passage: '`,
  `QUERY_PREFIX='query: '`.

## DoD

Constants + small pure helpers unit-tested (e.g. wrapper round-trip, slug validation);
commit.
