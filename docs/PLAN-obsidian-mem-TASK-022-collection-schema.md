# TASK-022 Milvus collection schema + indexes

Depends: TASK-021; follow research findings on lite-supported features.
`packages/service/src/milvus/schema.ts`.

## Scope

`ensureCollection(client, { dim })` idempotent builder for `obsidian_mem`:

| field | type | notes |
|---|---|---|
| chunk_id | Int64 | primary key (53-bit safe ids from core/idhash) |
| source_path | VarChar(1024) | absolute |
| section_header | VarChar(512) | header path |
| chunk_text | VarChar(65535) | `enable_analyzer: true` (BM25 text if lite supports the BM25 Function; else store analyzer text + fall back to client-side keyword scoring — record choice in code comment + README) |
| vault | VarChar(256) | vault root path |
| scope | VarChar(64) | **partition key** (global/domain/reference/project-slugs) |
| trigger_extensions | Array<VarChar(32)> | max_capacity 64 |
| trigger_frameworks | Array<VarChar(64)> | max_capacity 64 |
| wake_keywords | Array<VarChar(64)> | max_capacity 96 |
| dense_vector | FloatVector(dim) | default 768 (Q2) |
| (sparse) | SparseFloatVector | only if BM25 Function path |
| updated_at | Int64 | epoch ms |

- Indexes: dense HNSW (or IVF_FLAT; pick per findings, IP metric), sparse
  SPARSE_INVERTED_INDEX + BM25 params when present, INVERTED on vault/scope scalars.
- `vectorDim` drift: stored dim != configured dim → log + drop + rebuild flag (data is
  rebuildable from vaults; indexer re-inserts).
- Partition-key note: extra partition keys (per scope value) where findings show benefit;
  keep partition_key=scope as spec'd.

## DoD

Schema builder is pure JSON assembly (unit-testable without a server); field/index
assertions in vitest; RUN_LIVE creation covered by TASK-061; commit.
