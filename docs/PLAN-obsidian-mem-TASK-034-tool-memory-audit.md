# TASK-034 Tool: memory_audit

Depends: TASK-030, TASK-023, TASK-045 (interface may be stubbed until 045). `packages/tools/src/audit.ts`.
Read `/home/derek/src/engramory` audit process (SKILL.md / AGENT-SETUP.md doctor sections)
as the canonical reference before implementing.

## Scope

- No required params (`{}` → full doctor). Checks, each with ok/warn/fail + fix text:
  1. vaults exist, markdown/ present, shared vaults writable, read-only list.
  2. at least one shared vault (default created if none, report it).
  3. .INTENTS.md present in first shared vault; which of the 9 intent markers have
     recorded intents vs empty.
  4. Milvus reachable; collection exists; live count vs indexer state (drift N).
  5. indexer pending/errors counts; model cached in modelCacheDir.
  6. global memory injection budget: current injected tokens vs budgets.globalMemoryTokens
     (uses globalMemoryIndex()).
- **Over budget** → report instructs: run `memory_dream` to process and compact all global
  memory markdown files, and lists their absolute paths (sorted least-read first).
- Dreaming schedules summary from config (per Q4 audit↔dream link).
- Compaction analysis shared with memory_dream (single source of truth in service.audit()).

## DoD

Report-shape tests over fixture services (ok/warn/fail branches, over-budget instruction +
paths list); commit.
