# Obsidian Mem

[中文 (Chinese)](https://github.com/cybtachyon/dsh-plugin-obsidian-md/docs/translations/README.zh.md)

Shared agent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
built on plain Markdown vaults.

Obsidian Mem turns your Obsidian-style vaults into a frictionless,
human-editable working wiki that every agent session can read from and write to.

OM adds Retrieval-Augmented Generation (RAG) Recall with vector search powered
by a Milvus-Lite DB.

Open, edit, and sync your notes with a Markdown setup like Obsidian + Git,
then watch your agents learn from shared experiences.

## Install

Command line:
```bash
# Latest NPM package.
dsh plugin --profile web add dsh-plugin-obsidian-mem
```
```bash
# From source.
dsh plugin --profile web add https://github.com/cybtachyon/dsh-plugin-obsidian-mem
```

When installing from a local checkout, run pnpm build first: it type-checks the workspace (tsc -b) and then produces the dsh/client.js browser card artifact with esbuild (node scripts/build-client.mjs).

Web UI: click Plugins → Add Plugin → paste dsh-plugin-obsidian-mem.

Or add from the DSH Plugin Marketplace.

## Features

 - **Automatic RAG recall.** Lifecycle hooks inject relevant notes at turn start.
   When the agent encounters highly-relevant files or thinking keywords, that
   context (capped to a reasonable amount) is also injected.
   At turn-end, a reminder tells the agent what is worth saving.
 - **Five agent tools.**
   - `memory_read`: open a memory note from a vault by path.
   - `memory_search`: hybrid vector + keyword recall across your vaults.
   - `memory_write`: save a memory note (shared vaults only).
   - `memory_audit`: report vault size, index state, and over-budget warnings.
   - `memory_dream`: run the split-compaction pass that merges and prunes notes.
 - **Works out of the box.** Whether you have dozens of vaults, or just one or
   two AGENTS.md bullets that should be shared, you can configure your own shared
   vaults. Or just use a default shared vault at `$HOME/.dsh/obsidian-mem/`!
 - **Vault permissions.** Safeguard your Markdown as a vault as **Read-only**
   (agents query but never write) or work together with **Adopt and Share**
   (agents read and write). 
 - **Configurable settings.** The "Obsidian Mem" card in the Web GUI manages
   your list of vaults and file preferences. Adjust search and set up automatic
   Dreaming on a schedule. Of course, you can also ask your agent to set all of
   these up for you in DSH Creator mode too!
 - **Global memory file.** Vaults support a configurable, editable global memory
   file. They're added at session start within the global memory budget.

## Why another agentic memory project?

Out of the many, many out there (and I looked at as many as I could),
none of them:
 - let my add as many Markdown / Obsidian Vaults as I wanted
 - whenever I wanted
 - plus greatly customize the organization
 - AND have vector search + maintenance.

I wanted to share project notes with my agents and have maintained results
be the cumulative effort of human and automated knowledge organization.

## Storage layout

All `*.md` files are indexed, except: dot directories and dot files are
never indexed, and these vault-root paths are reserved for the plugin:

| Vault Path                | Description                                            |
| ------------------------------------ | ----------------------------------------------------------- |
| `<vault>/.<slug>_history.md`      | Note history retired by dreaming; reserved suffix. |
| `<vault>/.INTENTS.md`                | Agent intents file describing phrases that lead to memories.                             |
| `<vault>/.obsidian-mem/metadata/`    | Indexer state file and the `DREAMS.md` dream diary. |

| Plugin Path                  | Description                                            |
| ------------------------------------ | ----------------------------------------------------------- |
| `$HOME/.dsh/obsidian-mem/`           | The default shared vault (created if none are already added).   |
| `$HOME/.dsh/obsidian-mem-db/`        | The memory search Milvus-Lite database (rebuildable on-demand; safe to delete).      |
| `$HOME/.dsh/obsidian-mem-db/models/` | The memory search ONNX model cache.                        |

## Configuration

The settings card is available in the DSH plugin configuration:

| Knob                    | Default                              | Notes                                                            |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `vaults[]`              | `$HOME/.dsh/obsidian-mem/` | Each vault: `path`, `mode` (`shared` \| `readonly`), `globalFile` (vault-root relative; blank = `GLOBAL.md`) |
| `vectorDim`             | `384`                                | Full e5-small width; `128`..`320` are lossy; change = re-index   |
| `embeddingModel`        | `Xenova/multilingual-e5-small`       | ONNX q8, `passage:` / `query:` prefixes                        |
| `modelCacheDir`         | `$HOME/.dsh/obsidian-mem-db/models`  | transformers.js `env.cacheDir`                                   |
| `dbDir`                 | `$HOME/.dsh/obsidian-mem-db`         | Milvus-Lite data directory                                       |
| `keywordLlm`            | off                                  | Optional OpenAI-compatible endpoint that augments heuristic wake-keyword extraction |
| `recallBudget`          | per plan                             | Caps injected recall context per turn                            |

## Technical Background

The plugin manages its own vector database on-demand:
1. Ensures a `uv`/`uvx` toolchain (auto-installing `uv` when absent)
2. Spawns a local `milvus-lite` server bound to a localhost port with data under
   `$HOME/.dsh/obsidian-mem-db/`

There is no user-facing Python, Milvus install step, or external Milvus.

RAG is a Hybrid search with both dense (HNSW/COSINE) search and sparse BM25
search powered by a local ONNX model. `chunk_text` is stored without embed-time
prefixes and uses `enable_analyzer`.

## Model download and offline use

The plugin downloads `Xenova/multilingual-e5-small` (ONNX q8, roughly 135 MB)
into `$HOME/.dsh/obsidian-mem-db/models`.
For an offline host, pre-seed the cache on a connected machine:

```
node scripts/prefetch-model.mjs
```

## Development

Build, test, and lint with pnpm; see [AGENTS.md](AGENTS.md) for the
architecture and the verification commands.

 - `pnpm test` is fully offline: a second integration tier
(`packages/service/tests/integration/*.live.test.ts`) is collected only with
`RUN_LIVE=1 pnpm test`.
 - The live tier spawns a real uvx-managed milvus-lite (first run downloads it
   and can take several minutes).
 - Live loads the real `Xenova/multilingual-e5-small` model from the local
   cache and drives the full provisioning → indexing → hybrid search →
   write-through → purge pipeline.
 - Per-test timeouts are a generous 180 s to absorb cold caches.
 - Everything it writes lands in temporary directories; only the model cache is
   reused.
 
Run it with:

```
RUN_LIVE=1 pnpm test
```

## Reference and Prior-Art

 - The excellent [Tinqiao Engramory](https://github.com/tinqiao-oss/engramory/)
   Inspired a majority of the Markdown system design and memory management.
 - [Zilliz Memsearch](https://github.com/zilliztech/memsearch)
   Milvus search, reranking.
 - [bufan528 Memory Vault](https://github.com/bufan528/dsh-longterm-memory)
   Recall budgeting, metadata, extraction design.
 - The massive amount of DSH Markdown, RAG, and memory plugins, most of which
   were very interesting but did not provide useful work materia. Still, cool
   to see the community innovating and trying different things, and I learned
   a lot about what I did not like or want to use.
