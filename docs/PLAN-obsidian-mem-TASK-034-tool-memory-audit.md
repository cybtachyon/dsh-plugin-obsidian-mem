# TASK-034 Tool: memory_audit

Status: done

Depends: TASK-030, TASK-023, TASK-045 (interface may be stubbed until 045). `packages/tools/src/audit.ts`.
Read `/home/derek/src/engramory` audit process (SKILL.md / AGENT-SETUP.md doctor sections)
as the canonical reference before implementing.

## Scope

- No required params (`{}` → full doctor). Checks, each with ok/warn/fail + fix text:
  1. vaults exist, markdown/ present, shared vaults writable, read-only list.
  2. shared vault present. If none is configured AND the default has not been provisioned
     yet: report that the default vault will be created at its full path on first memory
     access (do NOT create it from audit; audit is a doctor, not an accessor). If the
     default vault is provisioned and in use: state that it is the default and give the
     full path (restating the Decision-log notice).
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
- Safety posture (engramory doctor + ext audit canon, findings §1.7/§2.7): audit WRITES
  NOTHING (no read-stat update, no commits; stat-only listing); optional params
  `view: 'full'|'topStale'|'oldestUnread'` + `limit` (default 50 rows; rollups cover the
  whole store); bounded reads (stat size BEFORE parse; notes > 4 MiB flagged, not read;
  over-budget report is size-only); any store text echoed into the report is quoted and
  truncated so a hostile note cannot flood or instruct the reader; severity split
  ISSUE vs INFO.

## DoD

Report-shape tests over fixture services (ok/warn/fail branches, over-budget instruction +
paths list); commit.
