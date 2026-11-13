# Obsidian Mem

Shared agent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
built on plain Markdown vaults. Obsidian Mem turns the Obsidian-style vaults you
already edit into a frictionless, human-editable working wiki that every agent
session can read from and write to. Recall is vector search over Milvus-Lite;
the notes themselves stay yours: open them, edit them, sync them with Obsidian or
git, and the index follows.

## What you get

- **Five agent tools**
  - `memory_read`: open a memory note from a vault by path.
  - `memory_search`: hybrid vector + keyword recall across your vaults.
  - `memory_write`: save a durable memory note (shared vaults only).
  - `memory_audit`: report vault size, index state, and over-budget warnings.
  - `memory_dream`: run the split-compaction pass that merges and prunes notes.
- **Automatic recall.** Lifecycle hooks inject relevant notes at turn start,
  when the agent reads a file, and when the Think stream hits a vault keyword.
  A turn-end reminder tells the agent what is worth saving.
- **Vault sharing modes.** Adopt a vault as **Adopt and Share** (agents read
  and write) or **Read-only** (agents query but never write).
- **Works out of the box.** With no vault configured, the first memory access
  (first tool call or lifecycle hook that touches memory) creates a default
  shared vault at `$HOME/.dsh/obsidian-mem/`, and the agent is told it is
  working in the default vault and given the full path. Installing the plugin
  never touches your disk: activation is side-effect free until a run actually
  uses memory, so you can set up your own vaults before the first agent run.
- **Settings card.** The "Obsidian Mem" card in the Web GUI manages the vault
  registry (paths, modes, re-index), the vector/index knobs, and the Dreaming
  section, where you add DSH schedule/timer triggers that wake agents to run
  `memory_dream`.

## Storage layout

| Path                              | What lives there                                        |
| --------------------------------- | ------------------------------------------------------- |
| `$HOME/.dsh/obsidian-mem/`        | The default shared vault (created on first memory access) |
| `$HOME/.dsh/obsidian-mem-db/`     | The Milvus-Lite database (rebuildable; safe to delete)  |
| `$HOME/.dsh/obsidian-mem/models/` | The transformers.js ONNX model cache                    |

Deleting `obsidian-mem-db` is always safe: the index is derived state and is
rebuilt from your Markdown notes on demand.

## Configuration knobs

The settings card (or the plugin's profile config) exposes:

| Knob                    | Default                              | Notes                                                            |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `vaults[]`              | (none; default vault is lazy-created) | Each vault: `path`, `mode` (`shared` \| `readonly`)              |
| `vectorDim`             | `384`                                | Full e5-small width; `128`..`320` are lossy; change = re-index   |
| `embeddingModel`        | `Xenova/multilingual-e5-small`       | ONNX q8, `passage:` / `query:` prefixes                        |
| `modelCacheDir`         | `$HOME/.dsh/obsidian-mem/models`     | transformers.js `env.cacheDir`                                   |
| `dbDir`                 | `$HOME/.dsh/obsidian-mem-db`         | Milvus-Lite data directory                                       |
| `keywordLlm`            | off                                  | Optional OpenAI-compatible endpoint that augments heuristic wake-keyword extraction |
| `recallBudget`          | per plan                             | Caps injected recall context per turn                            |

## Milvus-Lite bootstrap

The plugin manages its own vector database: on first memory use it ensures a
`uv`/`uvx` toolchain (auto-installing `uv` when absent), spawns a local
`milvus-lite` server bound to a localhost port with data under
`$HOME/.dsh/obsidian-mem-db/`, and connects through
`@zilliz/milvus2-sdk-node`. There is no user-facing Python or Milvus install
step, and no external Milvus to operate.

The `obsidian_mem` collection uses the BM25 Function path: `chunk_text` is
stored clean (no embed-time prefixes) with `enable_analyzer` on, a BM25
Function generates a `SparseFloatVector`, and dense (HNSW/COSINE) and sparse
(SPARSE_INVERTED_INDEX/BM25) indexes serve hybrid search. The client-side
keyword-scoring fallback is not needed because milvus-lite 3.2.2 supports the
analyzer and BM25 Function (verified, `docs/research/milvus-transformers-findings.md`
§3).

## Model download and offline use

On first embedding the plugin downloads `Xenova/multilingual-e5-small` (ONNX
q8, roughly 135 MB) into `$HOME/.dsh/obsidian-mem/models`. For an offline
host, pre-seed the cache on a connected machine:

```
node scripts/prefetch-model.mjs
```

## Development

Build, test, and lint with pnpm; see [AGENTS.md](AGENTS.md) for the
architecture and the verification commands.

`pnpm test` is fully offline: a second integration tier
(`packages/service/tests/integration/*.live.test.ts`) is collected only with
`RUN_LIVE=1 pnpm test`. The live tier spawns a real uvx-managed milvus-lite
(first run downloads the pinned wheel set and can take several minutes;
afterwards the cache is warm), loads the real `Xenova/multilingual-e5-small`
model from the local cache, and drives the full provisioning → indexing →
hybrid search → write-through → purge pipeline. Per-test timeouts are a
generous 180 s to absorb cold caches. Everything it writes lands in
temporary directories; only the model cache is reused. Run it with:

```
RUN_LIVE=1 pnpm test
```

## License

MIT. See [LICENSE](LICENSE).
