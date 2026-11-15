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
 - **Five agent tools.**
   - `memory_read`: open a memory note from a vault by path.
   - `memory_search`: hybrid vector + keyword recall across your vaults.
   - `memory_write`: save a memory note (shared vaults only).
   - `memory_audit`: report vault size, index state, git churn, and
     over-budget warnings; its `checkpoint` view is the end-of-work pass.
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

## Usage

The agent-facing end-of-work pass is the completion checkpoint: run
`memory_audit` with `view: "checkpoint"` to get the full note rows plus
the completion-checkpoint instructions, the pass where the agent promotes
what the session settled and retires what was transient. The turn-end
save/audit reminder that used to fire at the end of every agent turn was
removed; the internal memory-tool usage watch is all that stays at turn
end.

Dreaming runs in isolation. While a `memory_dream` run is in flight, the
dream agent session and every session in its subagent lineage receive no
memory recall injections, and the launching session receives none for
the window of the run. The dream agent session carries no deployment
system prompt and no session runtime context: its whole session context
is the dreaming protocol in the editable `dream-prompt.md` (seeded once
at `$HOME/.dsh/obsidian-mem-db/dream-prompt.md`) plus the work plan in
the launch message. Other sessions are unaffected, and the launching
session's recall resumes the moment the run closes.

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
| `$HOME/.dsh/obsidian-mem-db/state/`  | Plugin state: card settings overrides (`settings.json`), the vault registry (`vaults.json`), and session state. Stays here even when `milvus.dbPath` points elsewhere. |

## Configuration

Every knob below is a real config path. Set them in the plugin's config
row of your DSH profile, or edit the same keys in the "Obsidian Mem"
card's Configuration pane (below Vaults), which persists them as card
overrides in the plugin's state directory
(`$HOME/.dsh/obsidian-mem-db/state/settings.json`; the file stays there
even when `milvus.dbPath` points elsewhere). Card overrides win over the
same key in the profile row; "Reset all to profile settings" clears them.

| Knob | Default | Notes |
| ---- | ------- | ----- |
| `vaults[]` | `$HOME/.dsh/obsidian-mem/` | Each vault: `path`, `mode` (`shared` \| `read-only`), `globalFile` (vault-root relative; blank = `GLOBAL.md`). The card's Vaults pane and the profile row both manage the list; the default shared vault is created on first use when nothing is registered. |
| `vectorDim` | `384` | Full e5-small width; `128` / `192` / `256` / `320` are lossy truncations that trade recall for speed; a change forces a full re-index. |
| `model.id` | `Xenova/multilingual-e5-small` | ONNX q8 embedder, `passage:` / `query:` prefixes; changing it re-embeds every note. |
| `model.cacheDir` | `$HOME/.dsh/obsidian-mem-db/models` | transformers.js download cache; first use of a new directory re-downloads the model. |
| `milvus.dbPath` | `$HOME/.dsh/obsidian-mem-db` | Milvus-Lite data directory; a change applies on the next host restart and rebuilds the search index at the new location. |
| `llm.enabled` / `llm.baseUrl` / `llm.model` / `llm.apiKeyEnv` | off | Optional OpenAI-compatible endpoint that augments the heuristic wake-keyword extraction. `llm.apiKeyEnv` names the environment variable holding the API key; the key value itself is never stored or logged. |
| `budgets.turnStartRecallTokens` | `1200` | Token budget one turn-start recall injection may spend. |
| `budgets.globalMemoryTokens` | `1500` | Token ceiling for all recall injected across one session, counting the global memory file. |
| `budgets.readSections` | `2` | Most sections a Read-tool recall may inject. |
| `budgets.readSectionTokens` | `350` | Token budget each injected Read-tool section may spend. |
| `budgets.searchTopK` | `6` | Result count `memory_search` returns when the call omits `limit`. |
| `budgets.thinkShotsPerTurn` | `3` | Most keyword-extraction shots one turn may spend. |
| `git.enabled` | `true` | Card checkbox "Use Git to version shared vaults": shared vaults are git repositories and the plugin commits them (see Git versioning below). |
| `git.churnThresholdPercent` | `50` | Churn bar in whole percent: a note touched in more than this share of the recent commit window is a `memory_dream` stressor (see Git versioning below). |
| `git.churnWindowCommits` | `8` | How many of the most recent commits the churn share is measured over (see Git versioning below). |

Everything except `milvus.dbPath` applies to the running process on
Apply: budgets and the keyword LLM take effect on the next call, and a
`vectorDim` or `model.id` change starts its re-index right away.
`milvus.dbPath` takes effect on the next host restart; until then the
card shows a "restart to apply" chip.

The pane shows effective values, so to hand one knob back to the profile
row, blank the overridden text field: blanking deletes the override key
and the profile value returns. A blank number field sends nothing, and a
cleared override never writes an empty string, because an empty string
is the built-in default for a path knob.

### Git versioning

While `git.enabled` is on, every shared vault is a git repository
(`read-only` vaults are never versioned). The plugin adopts each shared
vault on the `main` branch with one initial commit recording whatever
notes the vault already holds. From then on a successful `memory_write`
schedules one commit of the vault it touched after the note is confirmed
(one commit per write, settling in the background, serialized per vault),
and a finished `memory_dream` run closes with one commit pass over every
shared vault. A git failure logs and never unwinds a write: the memory
files are the source of truth and the history is only the book.

A managed `.gitignore` at the vault root keeps the plugin's
`.obsidian-mem/` sidecar (indexer state, the `DREAMS.md` diary) out of
the history; `.git` itself never enters it.

Churn is read from git history: a note's churn is the share of the last
`git.churnWindowCommits` (default 8) commits that touched it, and a note
touched in over `git.churnThresholdPercent` (default 50)% of them is a
stressor under the dream agent's Step 4 rule. `memory_audit` reports the
per-note churn and a per-shared-vault git rollup.

A remote is optional and stays plain git you manage yourself
(`git remote add origin …` inside the vault); the plugin never creates
remotes or handles credentials. When a remote exists, the dream agent's
Step 0 pre-sync uses it before the run touches any memory.

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
   confirm-then-settle write → purge pipeline.
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
