# TASK-021 Milvus-Lite bootstrap (uvx auto-spawn)

Depends: TASK-010; consult `docs/research/milvus-transformers-findings.md` §Milvus for the
verified spawn command, db-file semantics, and Node SDK connection shape BEFORE coding.

## Scope (`packages/service/src/milvus/launcher.ts`)

- Config: `{ mode: 'spawn'|'external', address?, port?, dbPath? }` (default spawn;
  external skips spawn and uses address).
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

## DoD

Unit tests with injected spawner/child stubs (spawn args, config yaml contents, port
selection, external mode skips); RUN_LIVE integration left for TASK-061; commit.
