# TASK-021 Milvus-Lite bootstrap (uvx auto-spawn)

Depends: TASK-010; consult `docs/research/milvus-transformers-findings.md` §Milvus for the
verified spawn command, db-file semantics, and Node SDK connection shape BEFORE coding.

## Scope (`packages/service/src/milvus/launcher.ts`)

- Config: `{ mode: 'spawn'|'external', address?, port?, dbPath? }` (default spawn;
  external skips spawn and uses address).
- Start is LAZY: the service calls the launcher only from `ensureMemoryAccess()`
  (Decision log in PLAN), never at activation, so an unconfigured install spawns no
  child process.
- spawn mode lifecycle inside the plugin's own `ctx.effect`:
  1. ensure `uv`/`uvx` binary (probe PATH + `~/.local/bin`; when absent, auto-install uv via
     the official installer script; surface a friendly error if that fails).
  2. free port probe on 127.0.0.1; write a minimal milvus-lite config yaml into
     `$HOME/.dsh/obsidian-mem-db/` pointing at `memory.db`.
  3. spawn `uvx milvus-lite server --config-file <yaml>` (exact invocation per findings;
     pin `milvus-lite` version constant), detached=false, stdio piped to logger.
  4. wait for readiness (SDK checkHealth/waitForReady or TCP probe loop with timeout),
     expose address to the client factory.
  5. kill child on effect disposal (SIGTERM→SIGKILL grace).
- `milvusClient()` factory: `new MilvusClient({ address, ... })` shared instance, connect
  retries, error wrapping. Detect "collection not found"/connection errors and map to
  service errors with remediation text.
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
