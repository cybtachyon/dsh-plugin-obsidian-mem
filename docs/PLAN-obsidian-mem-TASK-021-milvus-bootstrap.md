# TASK-021 Milvus-Lite bootstrap (uvx auto-spawn)

Status: done

Depends: TASK-010; consult `docs/research/milvus-transformers-findings.md` §Milvus for the
verified spawn command, db-file semantics, and Node SDK connection shape BEFORE coding.

## Scope (`packages/service/src/milvus/launcher.ts`)

- Config: `{ mode: 'spawn'|'external', address?, port?, dbPath? }` (default spawn;
  external skips spawn and uses address).
- Start is LAZY: the service calls the launcher only from `ensureMemoryAccess()`
  (Decision log in PLAN), never at activation, so an unconfigured install spawns no
  child process.
- spawn mode lifecycle inside the plugin's own `ctx.effect` (VERIFIED bootstrap,
  findings §5; the data path `$HOME/.dsh/obsidian-mem-db/memory.db` is a DIRECTORY under
  milvus-lite 3.x — do not assume a file):
  1. ensure `uvx` (probe PATH + `~/.local/bin`; absent ⇒ auto-install uv via the official
     script; clear error if offline).
  2. free port via `net.createServer().listen(0)`; persist `{port,pid}` in
     `<dataDir>/.memlite.json` (lite writes no port file).
  3. probe first: if a Milvus answers on the recorded port and `getVersion()` starts with
     `milvus_lite`, ATTACH instead of spawning; foreign full-Milvus ⇒ honor external
     config only. `DataDirLockedError` on spawn ⇒ owner exists: attach via their port file
     or fail with an actionable message; never blind-retry.
  4. spawn EXACTLY: `uvx --with pymilvus --from milvus-lite==<PIN> milvus-lite server
     --data-dir <dbPath> --host 127.0.0.1 --port <p>` (`--with pymilvus` is mandatory —
     milvus-lite omits it; `--host 127.0.0.1` mandatory — default 0.0.0.0 has no auth;
     there is NO --config-file). Pin `milvus-lite==3.2.2` constant (3.x storage is
     directory-based and unreadable by 2.x; no migration).
  5. readiness: `await client.connectPromise`, then poll `checkHealth()` every 250 ms up
     to ~90 s (`waitForMilvusReady` does NOT exist in SDK 3.0.6). Cold uvx ~60 s; warm
     0.5 s — first-run UI should say so.
  6. kill child on effect disposal (SIGTERM→SIGKILL grace); lite has no shutdown RPC.
- `milvusClient()` factory: `new MilvusClient({address:'127.0.0.1:<p>', consistency_level:
  Strong, telemetry:{enabled:false}})`; `await connectPromise`; then checkHealth/getVersion
  handshake. EVERY call's response must pass an `assertOk` helper: the SDK RESOLVES on
  server errors (error_code in `.status` for insert/search/query, BARE ResStatus for
  createCollection/createIndex). A second concurrent plugin process must be refused
  cleanly (the LOCK file).
- Crash resilience: if the child dies, mark service degraded (memory_search returns
  explicit "index offline" message; audit reports it) and respawn with backoff.

## Prior-art traps (RESEARCH-FINDINGS.md §2 "scar tissue" — enforce all)

- Milvus Lite 3.x stores the DB as a DIRECTORY (2.x stored a file): detect layout; no auto
  migration — move aside + rebuild with a loud log line.
- Collection can sit "released": `loadCollection` before every search path.
- On shutdown `releaseCollection`/`releaseServer` (client close) or memory.db stays locked.
- Empty collection + BM25 hybrid can NaN: strong-consistency `count(*)` guard before
  querying; skip hybrid when empty (TASK-024).

## DoD

Unit tests with injected spawner/child stubs (spawn args, config yaml contents, port
selection, external mode skips); RUN_LIVE integration left for TASK-061; commit.
