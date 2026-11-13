# Milvus-Lite + Node SDK + transformers.js — Verified Findings

Research date: 2026-11-12 (America/Los_Angeles). Host: Arch Linux x86_64, kernel-class
glibc userland. All commands were run by this agent; results below are tagged:

| Tag | Meaning |
| --- | --- |
| `[V]` | Verified by a command this agent ran on this machine |
| `[D]` | Documented by an official source (URL cited), not reproduced |
| `[U]` | Uncertain / inferred / partially verified |

Test scaffolding lived entirely under `/tmp/mltest` (a `uv` venv with `milvus-lite 3.2.2` +
`pymilvus 3.0.3`, and an npm project with `@zilliz/milvus2-sdk-node 3.0.6` +
`@huggingface/transformers 4.3.2`). **Nothing in this repo was modified except this file.**

---

## 0. Headline answers

1. **Yes — `@zilliz/milvus2-sdk-node` 3.0.6 drives Milvus-Lite 3.2.2 over gRPC on
   `127.0.0.1:<port>`, and everything your plugin needs works.** 49/49 smoke steps and 34
   probe steps passed, including `Array<VarChar>` + `ARRAY_CONTAINS`, `TEXT_MATCH`, BM25
   `Function`, `SPARSE_FLOAT_VECTOR`, `hybridSearch` (RRF and weighted), partition keys,
   HNSW/FLAT/IVF_FLAT/AUTOINDEX/HNSW_SQ, JSON fields, delete-by-ids, range search. `[V]`
2. **There is no npm package and no Node binding.** `@zilliz/milvus-lite` → `404 Not Found`
   on the npm registry. The `milvus-io/milvus-lite` tree is 389 files, **zero** `.ts/.js/.go/.cpp/.rs`,
   pure Python (`pyproject.toml`, `milvus_lite/`). `[V]`
3. **Milvus-Lite was rewritten in pure Python at 3.0 (2026-05-13).** Wheels from 3.0 on are
   `py3-none-any` (~270 KB); ≤ 2.5.1 wheels are ~55 MB platform wheels that embed a 92 MB
   C++ `milvus` ELF. Current is **3.2.2** (2026-10-13). `[V]`
4. **`.db` no longer means a file.** In 3.x the `*.db` path is used as a **data directory**
   (`databases/`, `collections/<name>/{schema.json,manifest.json,wal}`, `aliases.json`, `LOCK`).
   A single-file `memory.db` is only the legacy 2.x behaviour. `[V]`
5. **The `uvx` bootstrap your PLAN assumes is broken as written.** `uvx --from milvus-lite
   milvus-lite server` dies with `ModuleNotFoundError: No module named 'pymilvus'`. It
   **must** be `uvx --with pymilvus --from milvus-lite milvus-lite server ...`. `[V]`
6. **`multilingual-e5-small` is 384-dimensional, not 768.** `config.json` says
   `hidden_size: 384`; transformers.js output `dims: [N, 384]`. Your PLAN's `vectorDim`
   default of `768` is not achievable with this model. `[V]`
7. **It is not MRL-trained**, and 384→256 truncation costs a measured ~14% recall@10
   overlap loss on a 32-passage / 9-query probe. 384 (store full) is the correct default. `[V]`
8. **transformers.js 4.x renamed the option**: `normalize: true`, **not** `normalization: true`.
   The v3 spelling is silently ignored and you get un-normalized vectors (‖v‖ ≈ 4.5). `[V]`

---

## 1. Local machine inventory `[V]`

| Check | Result |
| --- | --- |
| `node --version` | `v26.12.0` |
| `npm --version` | `11.20.0` |
| `python3 -V` | `3.14.9` |
| `which milvus` | not found |
| `which milvus-lite` | not found |
| `which pymilvus` | not found (it is a library, not a CLI) |
| `which python3 pip pip3` | `/usr/bin/python3`, `/usr/bin/pip`, `/usr/bin/pip3` |
| `which uv uvx` | `/home/derek/.local/bin/uv`, `/home/derek/.local/bin/uvx` |
| `pip show milvus-lite pymilvus` | `WARNING: Package(s) not found` (system python) |
| `docker`, `docker-compose` | present at `/usr/bin/docker`, `/usr/bin/docker-compose` |
| `podman` | not found |

So today the machine has **no Milvus at all**, but has `uv`/`uvx` (the bootstrap you picked)
and docker as a heavier fallback.

**Caveat for npm commands in this repo (resolved)**: the root
`/home/derek/src/dsh-plugin-obsidian-mem/package.json` declared
`devEngines.packageManager = pnpm@12.18.0`, so bare `npm info` / `npm view` run from
the repo root then failed with `EBADDEVENGINES` and registry queries had to run from a
neutral cwd (`/tmp`). The `devEngines` block was deleted by TASK-24 and npm commands now
run from the repo root. `[V]`

### Package facts from the registries `[V]`

`npm info @zilliz/milvus2-sdk-node` (run from `/tmp`):

- `version = 3.0.6`, `dist-tags = { latest: '3.0.6', next: '2.6.11-beta.0' }`
- no `engines` field in `package.json` (the README claims Node v18+)
- deps: `@grpc/grpc-js ^1.14.4`, `@grpc/proto-loader ^0.8.0`, `protobufjs ^7.6.3`,
  `generic-pool`, `winston`, `lru-cache`, `dayjs`, `@opentelemetry/api`,
  `@petamoriken/float16`, `@shanghaikid/parquetjs`
- version tail: `… 2.6.17, 3.0.0, 3.0.1, 3.0.2, 3.0.3, 3.0.4, 3.0.5, 3.0.6`
- `MilvusClient.sdkInfo` at runtime: `{ version: '3.0.6', recommendMilvus: 'v3.0.0' }`
- README compat table `[D]`: Milvus v3.0.0+ ↔ SDK 3.0.x; v2.6.x ↔ SDK 2.6.x; v2.5 ↔ SDK 2.5.12;
  v2.4 ↔ SDK 2.4.9

`npm view @zilliz/milvus-lite` → **`npm error code E404 … Not found`**. `[V]`
`npm search milvus` returns no milvus-lite-like embedded package (only adapters, MCP servers,
`dsh-context-milvus`, `@zilliz/dsh-milvus`, etc.). `[V]`

PyPI `milvus-lite`:

- latest `3.2.2` (uploaded 2026-10-13), `requires_python >= 3.10`
- deps: `faiss-cpu>=1.7.4`, `grpcio>=1.50`, `numpy>=1.24`, `pyarrow>=15.0`; extras `chinese`
  (`jieba`), `dev`. **`pymilvus` is deliberately absent.**
- wheel naming history tells the rewrite story: `2.4.x`–`2.5.1` are
  `py3-none-manylinux2014_x86_64` / `macosx_*` (≈ 20–56 MB); `2.5.2rc1` (2026-02-22) is the last
  binary wheel; `3.0` (2026-05-13) onward is `py3-none-any` (≈ 230–277 KB).

`npm info @huggingface/transformers`: `version = 4.3.2`, `dist-tags.next = 4.4.0-next.0`;
deps `onnxruntime-node 1.30.0`, `onnxruntime-web 1.31.0-dev.…`, `@huggingface/jinja ^0.5.10`,
`@huggingface/tokenizers ^0.2.0`, `sharp ^0.35.4`. `[V]`

---

## 2. Question 1 — can the Node SDK use Milvus-Lite? Yes, via the gRPC server mode

### 2.1 What Milvus-Lite is now `[D]` + `[V]`

From the current `milvus-io/milvus-lite` README:

> "This generation of Milvus Lite is rebuilt from scratch in pure Python. Instead of wrapping
> the full C++ Milvus core, it uses a local LSM-style storage engine with WAL, in-memory
> memtables, immutable Parquet segments, segment-level FAISS indexes, scalar filtering, BM25
> full text search, and a Milvus-compatible gRPC adapter."

It has three entry points: (a) `pymilvus.MilvusClient("./demo.db")` which auto-starts an
in-process server, (b) `milvus_lite.MilvusLite("./data")` embedded Python API, (c) the
standalone gRPC server CLI. **Only (c) is reachable from Node**, and it works.

### 2.2 The CLI — verified, not documented-as-you-remembered

`/tmp/mltest/venv/bin/milvus-lite --help` `[V]`:

```
usage: milvus-lite [-h] {server,dump} ...
subcommands:
  {server,dump}
    server    start the Milvus Lite gRPC server
    dump      dump a Milvus Lite collection to Milvus bulk JSON files
```

`milvus-lite server --help` `[V]`:

```
--data-dir DATA_DIR     Milvus Lite data directory (created if it doesn't exist).   [required]
--host HOST             bind host (default: 0.0.0.0)
--port PORT             bind port (default: 19530)
--max-workers MAX_WORKERS  thread pool size (default: 10)
```

**There is no `--config-file`.** That flag does not exist in 3.2.2. For completeness, the
*legacy* 2.5.1 console script (`milvus_lite/cmdline.py`, extracted from the wheel) only ever
registered the `dump` subcommand (`-d/--db-file`, `-c/--collection`, `-p/--path`) — there was
never a `milvus-lite server --config-file ...`. `[V]` In 2.x the server was spawned internally
by pymilvus, not by the CLI.

There is **no unix-socket option in 3.x** — TCP `--host/--port` only. (The legacy 2.x Python
`Server` class did pass `unix:<tmp>.sock` to the C++ binary when no address was given. `[V]`
from `milvus_lite/server.py` inside the 2.5.1 wheel.)

### 2.3 `.db` semantics — the important behavioural change

`milvus_lite/server_manager.py` docstring, verbatim `[V]`:

> "pymilvus calls `server_manager_instance.start_and_get_uri("./demo.db")` when it detects a
> `.db` URI. This module: 1. Uses the `.db` path as the MilvusLite data directory 2. Starts a
> gRPC server in a background thread on a free port 3. Returns `http://127.0.0.1:{port}`"

and `run_server(data_dir=abs_path, host="127.0.0.1", port=0)` confirms it: `port=0` means
auto-select a free port.

Consequences for `$HOME/.dsh/obsidian-mem-db/memory.db` `[V]`:

- With 3.x, `memory.db` becomes a **directory**. Observed layout after a short session:

  ```
  data/aliases.json
  data/.database-staging/
  data/LOCK                        <- advisory file lock
  data/databases/
  data/collections/<name>/schema.json
  data/collections/<name>/manifest.json
  data/collections/<name>/wal/
  (140K after ~10 collections)
  ```

- `.db` files written by the *original* (2.x) milvus-lite are **not readable** by 3.x; the
  README says "Re-import data into a new database; automatic migration is not available." `[D]`
  Pick a version now and stay on it, or your rebuild-on-incompatibility path must actually
  rebuild.
- Exclusivity: a second server on the same data dir exits with
  `milvus_lite.exceptions.DataDirLockedError: another process holds the lock on '<dir>':
  [Errno 11] Resource temporarily unavailable`. `[V]` This is your "already running" signal
  *if* you own the process; it is not a way to attach to someone else's server.
- Legacy 2.x, for contrast: `/tmp/wheel/x/db/memory.db` was created as a **single 28 KB file**. `[V]`

### 2.4 Does the legacy standalone binary let you skip Python? Yes, but it is unusable `[V]`

This is worth recording because it is the tempting shortcut. The 2.5.1 wheel contains
`milvus_lite/lib/milvus` — a 92.3 MB `ELF 64-bit LSB executable, x86-64, dynamically linked`,
alongside `libknowhere.so` (43 MB), `libopenblas.so.0` (36 MB), `libgfortran`, `libglog`,
`libgflags_nothreads`, `libdouble-conversion`, `libgcc_s`, `libgomp`, `libm`, `libpthread`.
Spawn signature from `milvus_lite/server.py`: `[milvus_bin, db_file, address, log_level]`.

I ran it with **no Python at runtime**, only `LD_LIBRARY_PATH` pointed at the extracted `lib/`:

```
LD_LIBRARY_PATH=/tmp/wheel/x/milvus_lite/lib \
  ./milvus_lite/lib/milvus /tmp/wheel/x/db/memory.db 127.0.0.1:19531 ERROR
```

It bound `127.0.0.1:19531` and created `memory.db`. Then I pointed `@zilliz/milvus2-sdk-node
3.0.6` at it. Results against the legacy binary:

| Step | Result |
| --- | --- |
| `connectPromise`, `checkHealth`, `getVersion`, `listDatabases` | passed (health/version returned `{}`) |
| `createCollection` (Array field, analyzer field) | Success |
| `createIndex` HNSW | **`invalid index type: HNSW, local mode only support FLAT IVF_FLAT AUTOINDEX`** |
| `search` with `ARRAY_CONTAINS` filter | **crash: `Cannot read properties of null (reading 'scores')`** |
| `query` with `TEXT_MATCH` | **`expr type check failed, actual type: JSON … segcore error`** |
| `hybridSearch` (dense + BM25) | **crash** (null results) |
| partition-key search | **crash** (null results) |
| range search | **crash** (null results) |
| plain `search` (BM25 field) | passed |
| `delete` by ids, `count`, `queryIterator` | passed |

**Do not ship the legacy path.** The pure-Python 3.2.2 adapter is strictly better with the
Node SDK, and it is what the rest of this document measures. `[U]` Whether SDK 2.5.x fares
better against the 2.x binary is untested and moot.

---

## 3. Question 2 — feature matrix, milvus-lite 3.2.2 driven by Node SDK 3.0.6 `[V]`

Server: `milvus-lite 3.2.2` (`getVersion()` → `"milvus_lite-3.2.2"`), gRPC on
`127.0.0.1:19530`. Client: `@zilliz/milvus2-sdk-node 3.0.6`.

### Passed (exercised end to end with real data)

| Capability | How verified |
| --- | --- |
| gRPC connect + handshake | `new MilvusClient({address})`, `await client.connectPromise` |
| `checkHealth()` | `{isHealthy: true, reasons: []}` |
| `getVersion()` | `"milvus_lite-3.2.2"` |
| `listDatabases()` | `{db_names: ["default"]}` |
| `createCollection` with `Int64` PK, `VarChar`, **`Array` of `VarChar` (`element_type`, `max_capacity`, `max_length`)**, `FloatVector(dim:256)`, `enable_dynamic_field` | Success; round-tripped array values |
| `createCollection` with inline `index_params` + `consistency_level` | Success |
| `VarChar` primary key (`is_primary_key`, `autoID:false`), insert/query/delete by string id | `ids: {str_id:{data:["note://a/b.md#chunk-0"]}}` |
| `autoID: true` Int64 PK | assigned ids `["1","2"]` |
| `nullable: true` + `default_value` | inserted omitted fields, read back `kind:"note"`, `maybe:null` |
| `createIndex` **HNSW/COSINE**, **FLAT**, **IVF_FLAT**, **AUTOINDEX**, **HNSW_SQ** | all built (`state:"Finished"`) and searched |
| `SPARSE_INVERTED_INDEX` with metric `IP` (user sparse) and `BM25` (Function output) | both built |
| `loadCollectionSync` / `loadCollection` / `getLoadState` / `releaseCollection` | worked |
| `insert`, `upsert`, `delete({ids})`, `delete({filter})`, `get`, `query`, `count` | counts correct after deletes |
| `search` + filter `ARRAY_CONTAINS(field, ".ts")` and lowercase `array_contains` | correct subset returned |
| `ARRAY_CONTAINS_ANY(field, [...])` (TASK-061 live re-probe, 3.2.2) | correct subset returned. CORRECTION: the camel-case `ARRAY_CONTAINSAny` spelling first wired in TASK-024 is NOT accepted by the lite parser (`unknown function`; supported set lists snake-case `array_contains_any`). Uppercase snake-case `ARRAY_CONTAINS_ANY` is what ships. |
| `ARRAY_LENGTH(field) >= 2` | correct |
| `TEXT_MATCH(chunk_text, "milvus")` in `query` **and** in `search.filter` | correct |
| `TEXT_MATCH` on a field with `enable_analyzer: true` **without** `enable_match` | worked (lite does not require `enable_match`) |
| combined `ARRAY_CONTAINS(...) and TEXT_MATCH(...)` | correct |
| `LIKE "notes/%"`, `IN [..]`, `is null`, `id in [..]` | correct |
| JSON field filters `payload["k"] == "v"`, `payload["nested"]["a"] > 1` | correct |
| dynamic fields (`enable_dynamic_field: true`), filter on `color`, on `$meta["nested"]["n"]` | correct |
| **BM25 `Function`** (`FunctionType.BM25`, `input_field_names`, `output_field_names`) | created; text auto-analyzed into the sparse field; BM25 search returned the right doc |
| **`hybridSearch`** dense + BM25 with `RRFRanker(60)` | Success, correct fused ordering |
| **`hybridSearch`** with `WeightedRanker([0.7, 0.3])` | Success (see gotcha G4 — the arg must be an array) |
| `hybridSearch` with **no** `rerank` | Success (defaults applied) |
| user-supplied `SparseFloatVector` field, `SPARSE_INVERTED_INDEX`/`IP`, dict format `{0:1.0, 1:100.0}` | `scores [1, 0.5]` — true inner product |
| `partition key` (`is_partition_key: true`) + `num_partitions: 16` + `filter: 'vault == "vaultA"'` | `query=1 search=1` |
| explicit `partition` create/list/load | `_default`, `p1` |
| `createDatabase` | Success |
| `createAlias` / `truncateCollection` / `renameCollection` / `compact` / `flush` / `flushSync` / `flushAll` | Success |
| `describeCollection` / `describeIndex` / `listIndexes` / `getCollectionStatistics` | correct payloads |
| `queryIterator` (async iterator) | iterated correctly |
| `group_by_field` in `search`; `offset` in `search` | Success |
| range search via `params: {radius, range_filter}` | filter demonstrably applied (see G8) |
| `consistency_level` `Strong`/`Session`/`Bounded`/`Eventually` at create and per-query | all accepted; read-after-write with `Strong` returned the just-inserted row |
| `max_length` enforcement | `VARCHAR field 't' value length 70000 exceeds max_length=65535` |
| `VarChar` `max_length: 65535` + 40 KB payload insert | Success |

### Rejected / broken / silently wrong

| Capability | Verified behaviour |
| --- | --- |
| **`DISKANN`** | `createIndex` **accepted** and `describeIndex` echoes `DISKANN`, `state:"Finished"`. But the README's supported list is `HNSW, HNSW_SQ, IVF_FLAT, IVF_SQ8, FLAT, BRUTE_FORCE, AUTOINDEX, SPARSE_INVERTED_INDEX, INVERTED` — no DISKANN. `[U]` Treat this as "type recorded, not honoured". Do not rely on it. |
| **`searchIterator`** | **Broken against lite.** `for await` yields nothing and logs `TypeError: Cannot read properties of undefined (reading 'token')`. SDK `dist/milvus/grpc/Data.js:810` reads `batchRes.search_iterator_v2_results.token` without optional chaining; lite never returns that field. Use `queryIterator` or manual `offset` paging. |
| **`upsert` + `field_ops: [{op:'ARRAY_APPEND'}]`** | **Silently replaces instead of appending.** Inserted `['.ts']`, upserted `['.md']` with `ARRAY_APPEND` (with and without `partial_update`) → final value `['.md']`. `ARRAY_REMOVE` presumably equally unimplemented. `[U]` Never use partial array ops on lite; read-modify-write in TS. |
| **`HttpClient` (REST)** | Not usable: lite has no REST proxy. `new HttpClient({endpoint:'127.0.0.1:19530'})` → `Failed to parse URL from 127.0.0.1:19530/v2/vectordb/collections/list` (it needs an `http://` scheme), and even then there is no server. gRPC only. |
| **`address` as a `.db` path** | `new MilvusClient({address:'/home/…/memory.db'})` logs `No port specified in address …` then `14 UNAVAILABLE: Name resolution failed for target dns:/home/…/memory.db`. The Node SDK cannot open a local file; there is **no** `MilvusClient("./memory.db")` equivalent. |
| `MilvusClient.describeAlias({alias})` | threw client-side `The \`collection_name\` property is missing.` — an SDK validation quirk, unrelated to lite. `[U]` |
| `alterCollectionProperties` | returned `Success`; almost certainly a no-op on lite. `[U]` |
| RBAC / auth / TLS | Not attempted. README `[D]`: "No authentication, users, roles, RBAC, or TLS; do not expose the local gRPC server on an untrusted network." Your client must not send credentials and you must bind `127.0.0.1`. |
| Binary / Float16 / BFloat16 / Int8 vectors; PQ indexes | `[D]` unsupported. Not needed by this plugin. |
| Concurrent writers to one collection | `[D]` "writes to the same collection must be serialized; concurrent writers are not supported safely." Single-process-per-data-dir lock enforced by you, not by lite's server mode across processes (the LOCK file does cover it). |
| Schema alteration, partition-level load/release | `[D]` unavailable (`UNIMPLEMENTED`). |

### The gotchas that will actually bite you `[V]`

- **G1 — the SDK does not throw on server errors.** `describeCollection({collection_name:
  'missing'})` *resolves* with `status.error_code: "CollectionNotExists"`. Every call must
  check the status or you will silently index nothing. Helper:
  `const assertOk = (r, what) => { const s = r?.status ?? r; if (s?.error_code && s.error_code !== 'Success') throw new Error(\`${what}: ${s.error_code} ${s.reason}\`); return r; }`
- **G2 — the status location differs per method.** `createCollection`, `dropCollection`,
  `createIndex` resolve to a **bare `ResStatus`** (`{error_code, reason, code, …}`);
  `insert`/`delete`/`query`/`search`/`get`/`count` nest it under `.status`. The helper above
  handles both. (My first test harness mis-scored exactly this and reported a
  "PASS" for a failed `createIndex`.)
- **G3 — sparse search requires an explicit `metric_type`.** Omit it and lite returns
  `error_code 6: sparse field 'sparse' requires metric BM25, got ''` (or `requires metric IP`
  for a user sparse field). Full Milvus infers the metric from the index; lite's adapter does
  not. Pass `metric_type` at the top level of `search()` and **inside each `data[]` item** of
  `hybridSearch()`.
- **G4 — `WeightedRanker` takes one array argument.** `utils/Search.js`: `const WeightedRanker
  = (weights) => ({strategy:'weighted', params:{weights}})`. `WeightedRanker(0.7, 0.3)` sends
  `weights: 0.7` and the server dies with `TypeError: object of type 'float' has no len()`.
  Write `WeightedRanker([0.7, 0.3])`.
- **G5 — `getLoadState` lies.** A freshly created, never-loaded collection already reports
  `LoadStateLoaded`. `[U]` Probably auto-load. Harmless, but don't use it as a readiness gate;
  use `checkHealth()` plus a probe query.
- **G6 — `releaseCollection` really releases.** Lite honoured it and subsequent searches
  returned `error_code 101: Collection '…' is in state 'released'; call load() before
  search/get/query`. Keep your own "loaded" flag.
- **G7 — BM25 scores can be negative.** A BM25 search returned `score: -2.66` for the correct
  hit. Consistent with the README's "BM25 IDF statistics are segment-local rather than
  global." Never assume `score >= 0`, never threshold BM25 scores at 0, and don't mix BM25
  and COSINE scores without normalizing (which is why `RRFRanker` is the safer default).
- **G8 — range search works and is exclusive-ish at the low end.** With COSINE and a single
  row at score `-0.00433`: `{radius:-1, range_filter:0.0}` → returned it;
  `{radius:0.0, range_filter:2}` → empty; `{radius:0.2, range_filter:0.9}` → empty. So the
  window is `(radius, range_filter]` in *similarity* space for COSINE. Exact inclusivity at
  the upper bound was not determined. `[U]`
- **G9 — dynamic-field projection quirk.** `output_fields: ['$meta["nested"]["n"]']` returned
  `{"$meta":{}}` while the *filter* on the same path matched. Request `'$meta'` if you need
  the values back. `[U]`
- **G10 — search results omit the primary key unless asked (Phase 3A addendum).** On lite
  3.2.2, `search` rows came back as `{score, <output_fields…>}` with NO `chunk_id` key until
  `chunk_id` was added to `output_fields`. Always list the PK explicitly in search/query
  projections. `[V]` (2026-11-12, live check)
- **G11 — SDK keepalive pings kill long-lived channels against lite.** SDK 3.0.6 `BaseClient`
  forces `grpc.keepalive_time_ms: 10000` + `keepalive_permit_without_calls: 1`; lite's Python
  gRPC server enforces HTTP/2 keepalive and answers with GOAWY `ENHANCE_YOUR_CALM`
  ("rejected by server because of excess pings. Increasing ping interval to 20000 ms"), after
  which the pooled channel is unreliable. Plugin clients must pass
  `channelOptions: {'grpc.keepalive_time_ms': 86_400_000, 'grpc.keepalive_permit_without_calls': 0}`
  (done in `milvus/client.ts createMilvusClient`). `[V]` (2026-11-12)
- **G12 — a gRPC client constructed against a not-yet-listening port never recovers.** The
  pool caches the ECONNREFUSED state: even after the server starts listening, its calls keep
  failing with `14 UNAVAILABLE ... connect ECONNREFUSED`. The readiness loop must construct a
  FRESH probe client per poll (done in `milvus/launcher.ts waitForReady`), and long-lived
  service clients must only be created after readiness. `[V]` (2026-11-12)
- **G13 — cold `uvx` on an empty uv cache can exceed 90 s.** The first-ever
  `uvx --with pymilvus --from milvus-lite==3.2.2 …` on this machine resolved and cached
  ~1.3 GB of wheels across multiple `uv` invocations; 90 s and even 400 s were exceeded,
  while warm-cache starts reach `LISTEN` in 2-25 s and full launcher `start()` took ~1.5 s.
  The §5.1 "~60 s cold" figure assumes a partially warm cache. First-run UI must not treat a
  >90 s cold start as failure (TASK-030/063: pass a generous `readinessTimeoutMs` or
  pre-warm with the same uvx command during install). `[V]` (2026-11-12)

---

## 4. Question 3 — exact Node API shape (verified against 3.0.6)

### 4.1 Names you asked about

| Question | Answer `[V]` |
| --- | --- |
| `client.hybridSearch` or `client.hybrid_search`? | **`hybridSearch`** (camelCase only). In `grpc/Data.js` line 51: `this.hybridSearch = this.search;` — it is literally an alias. |
| The sub-request key | **`data: HybridSearchSingleReq[]`**, **not** `requests`. The top-level npm README showing `requests:` is stale; the official doc page states "In the Node.js SDK, `hybridSearch()` is an alias for `search()`… with `data` as an array of individual search requests" and the type is `HybridSearchReq = Omit<SearchSimpleReq, …> & { data: HybridSearchSingleReq[]; rerank?: … }`. Dispatch: `isHybridSearchRequest` = `Array.isArray(data) && 'anns_field' in data[0]`. |
| Filter key | `filter` (or `expr`; `filter_params` for template values). |
| Range | inside `params: { radius, range_filter }`. HNSW `ef`, IVF `nprobe` also live in `params`. |
| Consistency | `consistency_level: ConsistencyLevelEnum.Strong` per request, or at `createCollection`. |
| Readiness | **`waitForMilvusReady` does not exist in 3.0.6** (grep of `dist/**/*.d.ts` finds only `connectPromise: Promise<void>` on `BaseClient`). Use `await client.connectPromise`, then `checkHealth()`, then `getVersion()`. |
| Rankers | exported: `RRFRanker`, `WeightedRanker`, `RANKER_TYPE` (`rrf` / `weighted`), `convertRerankParams`. Also exported: `MilvusClient`, `HttpClient`, `DataType`, `MetricType`, `IndexType`, `ConsistencyLevelEnum`, `FunctionType`, `ErrorCode`, `BulkWriter`, `FieldPartialUpdateOpType`. 185 exports total. |
| `createCollection` returns | a bare `ResStatus`. |
| `insert` returns | `{ succ_index, err_index, IDs: {int_id:{data:[…]}, id_field}, acknowledged, insert_cnt, …, status }` |
| `search` returns | `{ results: [{score, id, …output_fields}], recalls, session_ts, collection_name, status }` |

### 4.2 The minimal working file (this shape is what I actually ran)

```ts
import {
  MilvusClient, DataType, MetricType, ConsistencyLevelEnum,
  RRFRanker, WeightedRanker, FunctionType,
  type ResStatus,
} from '@zilliz/milvus2-sdk-node';

const DIM = 384; // multilingual-e5-small is 384-d. Not 768.

/** Assert a Milvus response succeeded. createCollection et al. return a bare ResStatus;
 *  insert/query/search nest it under .status. The SDK resolves on server errors. */
function assertOk<T>(r: T, what: string): T {
  const s = ((r as { status?: ResStatus })?.status ?? r) as ResStatus;
  if (s?.error_code && s.error_code !== 'Success') {
    throw new Error(`milvus ${what}: ${s.error_code} ${s.reason}`);
  }
  return r;
}

const client = new MilvusClient({
  address: '127.0.0.1:19530',      // required; "host:port", no scheme needed for gRPC
  // token / username / password: omit. Milvus-Lite has no auth.
  database: 'default',
  timeout: 30_000,                 // ms
  logLevel: 'warn',
  telemetry: { enabled: false },   // 3.0.x enables client telemetry by default; opt out
  pool: { max: 4, min: 1 },
});
await client.connectPromise;
assertOk(await client.checkHealth(), 'checkHealth');
assertOk(await client.getVersion(), 'getVersion');

// ---- schema: Int64 PK, VarChar scalars, Array<VarChar>, FloatVector, BM25 sparse ----
assertOk(await client.createCollection({
  collection_name: 'obsidian_mem',
  description: 'obsidian-mem chunks',
  enable_dynamic_field: true,
  consistency_level: ConsistencyLevelEnum.Strong,
  fields: [
    { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: false },
    { name: 'chunk_text', data_type: DataType.VarChar, max_length: 8192,
      enable_analyzer: true, enable_match: true },   // lite works with enable_analyzer alone
    { name: 'file_path', data_type: DataType.VarChar, max_length: 1024 },
    { name: 'source_type', data_type: DataType.VarChar, max_length: 32 },
    { name: 'vault', data_type: DataType.VarChar, max_length: 128, is_partition_key: true },
    { name: 'trigger_extensions', data_type: DataType.Array, element_type: DataType.VarChar,
      max_capacity: 32, max_length: 64 },
    { name: 'vector', data_type: DataType.FloatVector, dim: DIM },
    { name: 'sparse', data_type: DataType.SparseFloatVector },
  ],
  functions: [{
    name: 'bm25', type: FunctionType.BM25,
    input_field_names: ['chunk_text'], output_field_names: ['sparse'],
  }],
  num_partitions: 16,
}), 'createCollection');

// Indexes. Sparse metric_type MUST match what you will query with.
assertOk(await client.createIndex({
  collection_name: 'obsidian_mem', field_name: 'vector',
  index_type: 'HNSW', metric_type: MetricType.COSINE,
  params: { M: 16, efConstruction: 200 },
}), 'index vector');
assertOk(await client.createIndex({
  collection_name: 'obsidian_mem', field_name: 'sparse',
  index_type: 'SPARSE_INVERTED_INDEX', metric_type: MetricType.BM25,
}), 'index sparse');

assertOk(await client.loadCollectionSync({ collection_name: 'obsidian_mem' }), 'load');

// ---- insert ----
assertOk(await client.insert({
  collection_name: 'obsidian_mem',
  data: [{
    id: 1n as unknown as number,            // Int64; use string for values > 2^53
    chunk_text: 'Milvus hybrid search fuses dense and sparse routes.',
    file_path: 'notes/milvus.md', source_type: 'note', vault: 'default',
    trigger_extensions: ['.ts', '.tsx'],
    vector: dense /* number[DIM], L2-normalized */,
    // do NOT send `sparse`; the BM25 Function generates it from chunk_text
  }],
}), 'insert');

// ---- dense search with ARRAY_CONTAINS + TEXT_MATCH ----
const dense = await client.search({
  collection_name: 'obsidian_mem',
  data: [queryVector],
  anns_field: 'vector',
  metric_type: MetricType.COSINE,
  limit: 20,
  filter: `ARRAY_CONTAINS(trigger_extensions, ".ts") and TEXT_MATCH(chunk_text, "hybrid search")`,
  output_fields: ['file_path', 'chunk_text', 'trigger_extensions'],
  params: { ef: 64 },
  consistency_level: ConsistencyLevelEnum.Strong,
});
assertOk(dense, 'search');
dense.results.forEach(r => console.log(r.id, r.score, r.file_path));

// ---- hybrid search: dense + BM25. metric_type per sub-request is mandatory on lite ----
const hyb = await client.hybridSearch({
  collection_name: 'obsidian_mem',
  data: [
    { anns_field: 'vector', data: [queryVector], limit: 20, metric_type: MetricType.COSINE,
      params: { ef: 64 } },
    { anns_field: 'sparse', data: [rawQueryText], limit: 20, metric_type: MetricType.BM25,
      expr: `ARRAY_CONTAINS(trigger_extensions, ".ts")` },   // per-route filter goes in `expr`
  ],
  rerank: RRFRanker(60),                 // or WeightedRanker([0.7, 0.3])
  limit: 10,
  output_fields: ['file_path', 'chunk_text'],
});
assertOk(hyb, 'hybridSearch');

// ---- range search ----
await client.search({
  collection_name: 'obsidian_mem', data: [queryVector], anns_field: 'vector',
  metric_type: MetricType.COSINE, limit: 100,
  params: { radius: 0.2, range_filter: 1.0 },   // similarity window, not distance, for COSINE
});

// ---- delete ----
assertOk(await client.delete({ collection_name: 'obsidian_mem', ids: [1] }), 'delete by id');
assertOk(await client.delete({
  collection_name: 'obsidian_mem', filter: 'file_path == "notes/milvus.md"',
}), 'delete by filter');

client.close?.();
```

Filter-expression reference confirmed working on lite:
`== != > >= < <=`, `and or not`, `IN [...]`, `LIKE "prefix%"`, `ARRAY_CONTAINS(f, v)`,
`ARRAY_LENGTH(f) > n`, `TEXT_MATCH(f, "terms")`, `payload["a"]["b"] > n`, `$meta["k"] == v`,
`... is null` / `is not null` / `exists`, `id in [1,2]`. `[V]`

---

## 5. Question 4 — the bootstrap, corrected

Your PLAN already picked the right family (auto-spawn via uvx). It just needs the `pymilvus`
fix and the right flags.

### 5.1 The one command that works `[V]`

```
uvx --with pymilvus --from milvus-lite milvus-lite server \
    --data-dir "$HOME/.dsh/obsidian-mem-db" --host 127.0.0.1 --port <free-port>
```

- `--with pymilvus` is **not optional.** Without it, `milvus_lite/adapter/grpc/server.py`
  fails at import: `ModuleNotFoundError: No module named 'pymilvus'` (it imports
  `pymilvus.grpc_gen.milvus_pb2_grpc`), and milvus-lite does not declare pymilvus as a
  dependency. Verified failing and then verified working. Cold `uvx` took ~60 s (it resolves
  and downloads `faiss-cpu`, `pyarrow`, `numpy`, `grpcio`, `pymilvus`); warm it reaches
  LISTEN in **0.50 s**. `[V]`
- `--data-dir` takes a **directory**, not `memory.db`. Point it at
  `$HOME/.dsh/obsidian-mem-db` and drop the `.db` filename from the plan; or keep the name
  (e.g. `--data-dir .../obsidian-mem-db/memory.db`) accepting that it is a directory named
  `memory.db`.
- Always pass `--host 127.0.0.1`; the default is `0.0.0.0` and lite has no auth or TLS.
- The pre-installed-venv variant `/path/venv/bin/milvus-lite server …` also reaches LISTEN in
  0.50 s. `[V]`

### 5.2 Startup / health-check algorithm for `TASK-021-milvus-bootstrap`

```
1. resolve port: try net.createServer().listen(0) to get a free ephemeral port; persist
   {port, pid} in <dataDir>/.memlite.json so a restart can reuse or reap it.
   (Lite writes no port file, and the CLI has no --pid-file.)
2. probe: is something already answering on the configured port?
     new MilvusClient({address}).getVersion() -> version.startsWith('milvus_lite')
   If yes and it is ours, attach. If the version string is a plain Milvus (docker standalone),
   honour config.milvusAddress instead of spawning.
3. spawn: child_process.spawn(uvxPath, ['--with','pymilvus','--from','milvus-lite',
   'milvus-lite','server','--data-dir',dbDir,'--host','127.0.0.1','--port',port],
   { stdio: ['ignore','pipe','pipe'], detached: false, env: {...process.env} })
   - keep stderr; a failed spawn ends in DataDirLockedError or the pymilvus ImportError,
     both of which are one-line strings worth surfacing to the user.
4. wait-ready: poll every 250ms up to ~90s (cold uvx): connect with the Node SDK and call
   checkHealth() (not just TCP connect — gRPC accept is not the same as ready).
   There is no waitForMilvusReady in the SDK; this loop is the replacement.
   Phase 3A addendum: build a FRESH client per poll (G12: a client constructed before the
   port listens never recovers) and suppress keepalive pings on it (G11); a first-ever cold
   uvx with an empty cache can exceed even 400 s (G13).
5. data-dir lock: if spawn exits with DataDirLockedError, either another plugin instance owns
   it (find its port file and attach) or the dir is being used by a non-lite Milvus;
   fail with an actionable message rather than retrying.
6. after createCollection: always loadCollectionSync. Do NOT trust getLoadState (G5).
7. shutdown: child.kill('SIGTERM'); await exit; delete the port file. Register the same on
   process 'exit'/'SIGINT'. Lite has no RPC shutdown. Single-process-per-data-dir plus your
   file lock is the whole story.
8. serialize writes: lite is safe for concurrent reads but not concurrent writers to the same
   collection. Keep one indexer process; queue mutations in TS.
9. version pin: record the exact `milvus-lite==X.Y.Z` you certified and pass
   `--from milvus-lite==3.2.2` to uvx so an upstream release cannot change storage semantics
   under a live index. `[U]` uvx honours `pkg==version` in `--from`.
```

### 5.3 Fallback ladder `[V]`/`[D]`

1. **uvx spawn (recommended, verified above).** Cost: uv already present here; ~200–400 MB of
   Python wheels on first run; 0.5 s warm start.
2. **Pre-provisioned venv shipped/prefetched by a script** — same as (1) but
   `uv venv && uv pip install 'milvus-lite==3.2.2' pymilvus` once at install time, then spawn
   `<venv>/bin/milvus-lite`. Removes the cold-start network dependency.
3. **Docker Milvus standalone** (`/usr/bin/docker` and `docker-compose` exist here `[V]`).
   Use the stock compose file from the Milvus docs; the Node SDK connects to
   `localhost:19530` unchanged, and it needs `etcd` + MinIO, so it is a heavy dependency for a
   personal-memory plugin. It is also *not* lite: full features, and a different data story.
   `[D]` Not exercised in this session.
4. **Zilliz Cloud / external Milvus** — `MilvusClient({address, token})`; the README documents
   it. `[D]` Zero local footprint but leaks vault embeddings off-box: unacceptable here
   unless the user opts in.
5. **Legacy 2.x standalone binary** — proven spawnable from Node, proven unusable (§2.4).
   Recorded only so nobody re-explores it.

---

## 6. Question 5 — transformers.js and multilingual-e5-small

### 6.1 Version and API surface `[V]`

`@huggingface/transformers 4.3.2` (latest; `next = 4.4.0-next.0`). Node entry
`dist/transformers.node.cjs`. `require('onnxruntime-node')` loads fine; the `postinstall`
native-download script that npm blocked was not needed (prebuilt `bin/napi-v6/linux/x64`
shipped in the tarball).

**The option rename that will silently corrupt your embeddings:**

`src/pipelines/feature-extraction.js` `_call(texts, { pooling = 'none', normalize = false,
quantize = false, precision = 'binary' })`. There is **no `pooler` config on the pipeline and
no `normalization` option** in v4. Verified by measurement:

| Call | Resulting ‖v‖₂ |
| --- | --- |
| `extractor(texts, { pooling:'mean', normalize: true })` | `1.0000` for all vectors |
| `extractor(texts, { pooling:'mean', normalization: true })` (v2/v3 spelling) | `4.5155` — silently un-normalized |

If your COSINE index stores un-normalized vectors, scores are inner products with a
length bias and your `radius`/threshold logic is wrong. Assert the norm once at startup, or
compute it: `if (Math.abs(norm - 1) > 1e-3) throw …`.

Pooling choices actually implemented: `'none' | 'mean' | 'cls' | 'first_token' | 'eos' |
'last_token'`; `normalize` runs `result.normalize(2, -1)`; `quantize:true` with
`precision:'binary'|'ubinary'` packs bits (`{pooling:'mean', normalize:true, quantize:true}`
on a 384-d vector returned `dims [1,48], type int8` = 384 bits). `mean_pooling` and
`quantize_embeddings` are also exported for manual use.

### 6.2 The model: **384 dimensions** `[V]`

- `Xenova/multilingual-e5-small` `config.json`: `"hidden_size": 384`, `num_hidden_layers: 12`,
  `num_attention_heads: 12`, `max_position_embeddings: 512`, `vocab_size: 250037`,
  `tokenizer_class: XLMRobertaTokenizer`, `_name_or_path: intfloat/multilingual-e5-small`.
- transformers.js output: `Tensor { dims: [6, 384] }`.
- Google Cloud's model card also states "Output dimensions: Up to 384". `[D]`
- `768` is `multilingual-e5-base`; `1024` is `multilingual-e5-large`.

### 6.3 `env` knobs — exact defaults and behaviour `[V]`

Node defaults printed at runtime: `allowRemoteModels=true`, `remoteHost=https://huggingface.co/`,
`allowLocalModels=true`, `localModelPath=<pkg>/models/`, `useFS=true`, `useFSCache=true`,
`useCustomCache=false`, `cacheDir=<pkg>/.cache/`, `useBrowserCache=false`.

Usage that works (verified by observing where files landed):

```js
import { env, pipeline } from '@huggingface/transformers';
env.cacheDir = process.env.DSH_MEM_MODEL_CACHE ?? '~/.dsh/obsidian-mem/models';
env.allowLocalModels = false;   // skip the ./models + package-local lookup
// env.allowRemoteModels stays true for runtime download; set false with a prefetched cache
```

Files actually written under `cacheDir` (layout is `<cacheDir>/<org>--or--repo-id/...`
→ observed as `Xenova/multilingual-e5-small/...`):

| File | Size |
| --- | --- |
| `onnx/model.onnx` (fp32) | 470.3 MB |
| `onnx/model_quantized.onnx` (q8) | 118.3 MB |
| `tokenizer.json` | 17.1 MB |
| `config.json`, `tokenizer_config.json` | ~0 |

`useCustomCache=false` did **not** prevent `env.cacheDir` from being honoured on Node. `[V]`

### 6.4 ONNX variants and how `dtype` maps to files `[V]`

Repo file list (`/api/models/Xenova/multilingual-e5-small`, last modified 2025-07-22):
`onnx/model.onnx` 470 MB, `model_int8.onnx` 118.1 MB, `model_uint8.onnx` 118.1 MB,
`model_quantized.onnx` 118.3 MB, `model_fp16.onnx` 235.3 MB, `model_bnb4.onnx` 397.3 MB,
`model_q4.onnx` 398.6 MB, `model_q4f16.onnx` 204.8 MB, plus `quant_config.json`
(`per_channel: true, reduce_range: true`) and `sentencepiece.bpe.model`.

`src/utils/dtypes.js` suffix map: `fp32 → ''`, `int8 → '_int8'`, `uint8 → '_uint8'`,
`q8 → '_quantized'` (also `fp16`, `bnb4`, `q4`, `q4f16`). So `pipeline(..., { dtype:'q8' })`
loads `model_quantized.onnx`; `{ dtype:'int8' }` loads `model_int8.onnx`. Both exist here.
Default for the `wasm` device is `q8`; other devices default to `fp32` — **always pass
`dtype` explicitly.**

`int8`/`q8` is **safe**: fp32 vs q8 cosine agreement per vector was
`0.9944 – 0.9964` across 7 vectors, and identical top-1 rankings. `[V]`

**Correct your PLAN's size estimate:** "int8, ~30 MB" is wrong. The realistic first-run
download is **118 MB model + 17 MB tokenizer ≈ 135 MB** (fp32 would be ≈ 487 MB). `[V]`

### 6.5 Runtime cost `[V]`

Warm, 5 embed batches of 3 short texts: `q8` 39 ms, `fp32` 42 ms → roughly **8 ms per short
text** on this machine, model load aside (first load pulled 470 MB in 66 s; warm q8 load is a
file read + ORT session init).

### 6.6 The e5 prefix is load-bearing `[V]`

The card `[D]` says: "Each input text should start with `query: ` or `passage: `, even for
non-English texts." transformers.js does **not** add it; you must prepend it yourself.

Ablation on 5 passages / 1 query: with prefixes the correct passage ranked 1st; without
prefixes the ranking became `3,0,2,1` (wrong top hit), even though the query vectors with and
without the prefix had cosine `0.9947`. Keep the `query:` / `passage:` prefixes, and keep them
out of the stored `chunk_text` used for BM25/`TEXT_MATCH` (otherwise every passage contains
the token "passage" and every query "query", polluting BM25 — store the clean text and add
the prefix only at embed time).

### 6.7 Matryoshka: not MRL, and here is what truncation actually costs `[V]`

- `intfloat/multilingual-e5-small` README (18 484 lines, mostly MTEB YAML) contains **zero**
  occurrences of "Matryoshka", "MRL", or any supported-dimensions list. The only "truncate"
  hit is "Long texts will be truncated to at most 512 tokens." Card last modified 2026-04-02.
- The card's own usage recipe is `average_pool(last_hidden_state, attention_mask)` then
  `F.normalize(..., p=2, dim=1)` — mean pooling + L2 normalize, i.e. plain dense embeddings.
- HF has no official MRL variant of e5-small. Community fine-tunes exist
  (`Fjoralb1/multilingual-e5-small-nli-matryoshka-128`, `anhtuansh/multilingual-e5-base-Matryoshka-*`)
  but are low-download and have **no ONNX export for transformers.js**.
- **No repo provides a 256-d e5-small variant.**

Measured truncation fidelity (32 passages, 9 queries — English, Spanish, Japanese, German;
q8 model; **both query and passages truncated then L2 re-normalized**; Spearman over the full
32-passage score ranking):

| k | top-1 identical | recall@10 overlap | rank corr | mean \|Δcos\| | L2 energy kept |
| --- | --- | --- | --- | --- | --- |
| 384 (full) | 100% | 100.0% | 1.000 | 0.0000 | 1.000 |
| 320 | 100% | 91.1% | 0.974 | 0.0045 | 0.839 |
| **256** | **100%** | **85.6%** | **0.939** | **0.0078** | **0.668** |
| 192 | 100% | 80.0% | 0.918 | 0.0125 | 0.513 |
| 128 | 89% | 78.9% | 0.874 | 0.0196 | 0.355 |
| 96 | 89% | 76.7% | 0.848 | 0.0183 | 0.256 |

Top-3 topic correctness at k=256 vs k=384: 8/9 queries identical; 1 differed.
Only 66.8% of L2 energy survives in the first 256 dims — the representation is **not**
front-loaded, which is exactly the signature of a non-MRL model.

**Recommendation.** Use `vectorDim = 384` (store the full vector). The saving from 256 is
33% of a vector that costs ~1.5 KB, against a ~14% recall@10 perturbation — a bad trade for a
memory plugin where the whole point is not missing the note. If you still expose the knob,
document it as "lossy dimension truncation, not Matryoshka", keep query and passage
truncation symmetric, and force a re-index when it changes. `[U]` Sample size is small (32
passages / 9 queries); the direction is robust, the exact percentages are not.

If a smaller vector is a hard requirement, prefer switching model family to a genuinely
MRL-trained multilingual model over truncating e5. `[U]` I did not evaluate ONNX transformers.js
exports of MRL multilingual models; that is a follow-up, not a verified finding.

Two levers that get the same memory win with less risk: `normalize:true` + `MetricType.COSINE`
so you can use `radius` range search, and `quantize:true` binary embeddings (§6.1) for a
coarse first-pass filter — both verified as available, neither benchmarked for recall here.

---

## 7. Question 6 — reimplementing LangChain's `MarkdownHeaderTextSplitter`

Source: `libs/text-splitters/langchain_text_splitters/markdown.py` at commit
`e2db474707c90248f74b1398ea6f13883605f7e7` (fetched in full, this session). The class is
pure-Python, no dependencies, and is directly transliterable to TypeScript.

### 7.1 Constructor

- Stores `return_each_line` (default `false`) and `strip_headers` (default `true`).
- **Sorts `headers_to_split_on` by `len(header_token)` descending** — so `"###"` is tested
  before `"##"` before `"#"`. This ordering is load-bearing; keep it.
- `custom_header_patterns: dict[str,int] | None` (e.g. `{"**": 1, "***": 2}`) lets non-`#`
  tokens act as headers. Optional; skip unless you want `**Bold**` headers.

### 7.2 `split_text(text)` state machine

```
lines            = text.split("\n")                  # NOT splitlines: \r\n keeps the \r,
                                                     # but see printable-filter below
lines_with_meta  = []
current_content  = []
current_metadata = {}
header_stack     = []           # {level:int, name:str, data:str}
initial_metadata = {}           # accumulated name -> header text
in_code_block    = false
opening_fence    = ""
```

For each raw line:

1. `stripped = line.trim()`, then **remove all non-printable characters**:
   Python `"".join(filter(str.isprintable, stripped))`. In TS,
   `stripped.replace(/[^\P{C}\p{Zs}]/gu, '')` is close but Python's `str.isprintable` also
   excludes all `Cc/Cf/Cs/Co/Cn/Zl/Zp` except `Zs`; simplest faithful rule: drop every char
   whose category is not printable, keeping spaces. This silently deletes `\r`, so `\r\n`
   input is handled. `[U]` exact category parity not proven.
2. **Fence tracking, evaluated before anything else:**
   - if `!in_code_block`: enter on `stripped.startsWith("```") && count(stripped,"```") === 1`
     (fence ```` ``` ````), else on `stripped.startsWith("~~~")` (fence `~~~`).
   - else if `stripped.startsWith(opening_fence)`: exit, clear `opening_fence`.
   - Note the `count("```") === 1` test: a single-line ```` ```js code ``` ```` does **not**
     open a block.
3. if `in_code_block`: `current_content.push(stripped)`; **`continue`** — importantly the
   trailing `current_metadata = {...initial_metadata}` update is skipped for these lines, and
   a `#` inside a fence is never a header.
4. Otherwise loop `for (const [sep, name] of headersToSplitOn)`:
   - `isStandard = stripped.startsWith(sep) && (stripped.length === sep.length ||
     stripped[sep.length] === ' ')`. So `"#"` alone is a header; `"#Title"` (no space) is
     **not**; `"### x"` when only `"#"`/`"##"` are configured is **not** a header of any
     configured level and falls through to content.
   - `isCustom` = the custom-pattern regex (see 7.4).
   - On a match:
     1. if `name !== null`:
        - `level = customPatterns[sep] ?? countChar(sep, '#')`
        - **pop the header stack** while `stack.at(-1).level >= level`, deleting each popped
          header's `name` from `initial_metadata`. (Siblings and deeper children are dropped;
          ancestors survive.)
        - `headerText = isCustom ? stripped.slice(sep.length, -sep.length).trim()
          : stripped.slice(sep.length).trim()`
        - push `{level, name, data: headerText}` and set `initial_metadata[name] = headerText`
     2. **flush**: `if (current_content.length) { push({content: join('\n', current_content),
        metadata: {...current_metadata}}); current_content = [] }`
     3. `if (!strip_headers) current_content.push(stripped)`
     4. `break` (only the first matching separator wins)
   - If **no** separator matched (Python `for…else`):
     - `if (stripped) current_content.push(stripped)`
     - `else if (current_content.length) { flush as above }` — **a blank line terminates the
       current chunk entry.** A blank line when `current_content` is empty emits nothing.
5. At the end of each *non-code* line iteration: `current_metadata = {...initial_metadata}`.
   The metadata attached to a chunk is therefore the header context that was in force when
   the chunk *started* (it was snapshotted before the header line mutated `initial_metadata`).
   This is the subtle part: when a header is seen, the content buffered *before* it is
   flushed with the **pre-header** `current_metadata`.
6. After the loop: `if (current_content.length) push({content: join('\n', current_content),
   metadata: current_metadata})` (note: not a copy in the original — irrelevant in TS).

### 7.3 `aggregate_lines_to_chunks(lines)`

```
aggregated = []
for line of lines:
  if (aggregated.length && deepEqual(last.metadata, line.metadata)):
      last.content += "  \n" + line.content            # two spaces + \n = markdown hard break
  else if (aggregated.length
           && !deepEqual(last.metadata, line.metadata)
           && Object.keys(last.metadata).length < Object.keys(line.metadata).length
           && last.content.split("\n").at(-1)[0] === "#"      # last line starts with '#'
           && !this.strip_headers):
      last.content += "  \n" + line.content
      last.metadata  = line.metadata                   # adopt the deeper header context
  else:
      aggregated.push(line)
return aggregated.map(c => ({ page_content: c.content, metadata: c.metadata }))
```

That second branch exists only for `strip_headers === false`, to avoid emitting a header line
as its own document. **The join string is `"  \n"` (two spaces + newline), so the original
blank line between paragraphs is lost.** `"a\n\nb"` becomes `"a  \nb"`. Reproduce it exactly
if you want LangChain-identical `page_content`, or deliberately deviate (and document it) if
you would rather preserve paragraph breaks.

`return_each_line === true` bypasses aggregation and yields one document per line entry.

### 7.4 `custom_header_patterns` matcher (only if you implement it)

`re.escape(sep)` then `^{sep}(?!{sep})(.+?)(?<!{sep}){sep}$`, matched against the *stripped*
line. The content group must be non-empty and must not consist solely of separator characters
(ignoring spaces). Header text for a custom header is `stripped[len(sep) : -len(sep)].trim()`.
Its level comes from the dict, not from `#` counting.

### 7.5 Edge cases to encode as tests

| Input | Behaviour |
| --- | --- |
| ` ```python\n# not a header\n``` ` | lines inside the fence are content; the fence lines themselves are content too |
| `~~~` fences | tracked symmetrically, closing test is `startsWith("~~~")` |
| `#Header` (no space) | content, not a header |
| `#` (bare) | header with empty text |
| `###` when only `#`,`##` configured | becomes content of the surrounding chunk |
| Skipping levels (`#` then `###`) | both are pushed; `initial_metadata` holds both names |
| `##` after `###` | `###` popped, its metadata key removed |
| sibling `##` after `##` | previous `##` popped (same level), its key replaced |
| non-printable characters | stripped from every line |
| header names | the **second element** of your tuples becomes the metadata key (e.g. `("##","H2")` → `{"H2": "..."}`); only configured levels appear in metadata |
| metadata equality | Python dict `==` — compare key sets and values, insertion-order-insensitive |
| front matter (`---` block at top) | **not special-cased**: `---` is content here (only the *Experimental* splitter treats rules specially), and `#` inside front matter would be parsed as a header. Strip YAML front matter **before** calling this splitter. `[U]` (behaviour inferred from absence of any front-matter handling in the source) |

### 7.6 Related classes (not the target, noted for completeness)

- `MarkdownTextSplitter` = `RecursiveCharacterTextSplitter` with
  `get_separators_for_language(Language.MARKDOWN)` — a different algorithm; its exact separator
  list lives in `character.py` and was **not fetched** this session. `[U]`
- `ExperimentalMarkdownSyntaxTextSplitter` — a re-implementation that keeps original
  whitespace (`splitlines(keepends=True)`), splits on horizontal rules (`***`/`---`/`___`),
  carves code blocks into their own chunk with a `"Code": <lang>` metadata key, applies the
  header stack as metadata at flush time, and discards whitespace-only documents. If your
  chunker must preserve exact markdown, evaluate this one first; it is materially simpler and
  has no hard-break join. `[D]` source read, not benchmarked.

---

## 8. Corrections to `PLAN-obsidian-mem.md`

| PLAN statement | Finding |
| --- | --- |
| "`vectorDim` … default `768`; accepts 256/384/768" (line 52 of README, Q2 answer) | **Invalid.** `multilingual-e5-small` is 384-d. 768 belongs to e5-base, 1024 to e5-large. Default must be `384`, with `256`/`192`/`128` as documented-lossy truncations. `[V]` |
| "spawns `milvus-lite server` via uvx/uv managed Python" | Correct idea, incomplete command. Must be `uvx --with pymilvus --from milvus-lite milvus-lite server --data-dir <dir> --host 127.0.0.1 --port <p>`. Cold uvx ≈ 60 s, warm ≈ 0.5 s. `[V]` |
| "spawns `milvus-lite server --config-file …`" (implied by the research brief) | `--config-file` does not exist in any milvus-lite CLI. Flags are `--data-dir` (required), `--host`, `--port`, `--max-workers`. `[V]` |
| "Milvus-Lite … ships as a Python package embedding a Milvus server binary" | True of ≤ 2.5.1 only. 3.x is pure Python, no binary. `[V]` |
| "`$HOME/.dsh/obsidian-mem-db/memory.db`" as the DB path | In 3.x the path is a **directory**. Also `.db` files from 2.x are unreadable by 3.x — pin the version. `[V]` |
| "Xenova/multilingual-e5-small, ONNX int8, ~30 MB" | q8 `model_quantized.onnx` is 118 MB + 17 MB tokenizer ≈ 135 MB. `[V]` |
| "`passage:` / `query:` prefixes" | Correct and necessary — verified that omitting them flips the top hit. Apply at embed time only; store clean text for BM25. `[V]` |
| Implicit: use `pooling`/`normalization` pipeline options | transformers.js **4.x** is `normalize`. `normalization` is ignored. `[V]` |
| `vectorDim` knob "no slicing of embeddings by default" | Keep this; add that 256 truncation costs 14% recall@10 overlap on the probe corpus. `[V]` |

---

## 9. Open / uncertain items

1. `[U]` Whether `DISKANN`/`HNSW_SQ` on lite are truly honoured or silently downcast to a
   FAISS fallback — `describeIndex` echoes the requested type; only FAISS internals could say.
2. `[U]` Upper-bound inclusivity of `range_filter` for COSINE range search.
3. `[U]` `ARRAY_APPEND`/`ARRAY_REMOVE` on lite: only the append path was probed, and it
   behaved as replace. Do not use.
4. `[U]` `searchIterator` breakage is SDK-version-specific (3.0.6) and might be fixed with a
   `search_iterator_v2` server capability flag; no capability negotiation exists on lite.
5. `[U]` Concurrency limits of the lite gRPC adapter under your indexer's write rate —
   untested; README says serialize writers, so assume one writer.
6. `[U]` MRL-trained multilingual alternatives with transformers.js ONNX exports (needed only
   if 384-d is unacceptable). Not evaluated.
7. `[U]` Exact Python `str.isprintable` parity for the TS port of the markdown splitter.
8. `[U]` Cold-start behaviour of `uvx` on a machine with no uv and no network: your
   `ensureUv()` step needs an offline error path.

## 10. Sources

- [milvus-io/milvus-lite README (main)](https://raw.githubusercontent.com/milvus-io/milvus-lite/main/README.md)
- [milvus-lite 2.5.1 wheel](https://pypi.org/project/milvus-lite/2.5.1/) — `milvus_lite/lib/milvus`, `server.py`, `cmdline.py` extracted
- [PyPI milvus-lite JSON](https://pypi.org/pypi/milvus-lite/json)
- [milvus-io/milvus-sdk-node README (main)](https://raw.githubusercontent.com/milvus-io/milvus-sdk-node/main/README.md)
- [Node SDK Hybrid Search doc](https://raw.githubusercontent.com/milvus-io/milvus-sdk-node/main/docs/src/content/docs/operations/hybrid-search.mdx)
- [npm @zilliz/milvus2-sdk-node](https://www.npmjs.com/package/@zilliz/milvus2-sdk-node)
- [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)
- [intfloat/multilingual-e5-small card](https://huggingface.co/intfloat/multilingual-e5-small)
- [Multilingual E5 technical report (arXiv:2402.05672)](https://arxiv.org/abs/2402.05672)
- [langchain markdown.py @ e2db474](https://github.com/langchain-ai/langchain/blob/e2db474707c90248f74b1398ea6f13883605f7e7/libs/text-splitters/langchain_text_splitters/markdown.py)
