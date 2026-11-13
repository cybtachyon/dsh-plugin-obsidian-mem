# TASK-042 Read tool-call intercept

Status: done

Depends: TASK-040, TASK-024. `packages/events/src/readIntercept.ts`.

## Scope

- Listener: `tools/result` (emit; observe final outcome) or `tools/post-execute` returning
  `next()` unchanged — pick per practices.md ("observe final tool outcomes on tools/result").
  Filter: tool name `read` (harness Read tool) with `file_path` arg.
- Extract: file extension, directory signals (path segments: src/tests/pkg names), import
  snippet (first ~2 KB: `import|require|use|from` lines, max 12 lines).
- Call `searchExactSections(filePath, { ext, dirSignals, snippet, k=2,
  sectionTokens=350 })` (exact-file chunks first, ext/framework ARRAY_CONTAINS fallback).
  Search goes through `service.ensureMemoryAccess()`; a pending one-time default-vault
  notice is prepended to the injection (Decision log).
- Respect `shouldInject` (source once per session) + per-session throttle (skip when last
  read-injection < 15s or same dir already covered) + thinkBudget-independent cap.
- Inject with `agent.inject()` wrapped `<recalled_memory source=...>`; mark injected.
  Never inject for reads of files inside vaults (memory files themselves) to avoid loops.

## DoD

Tests: ext/signal extraction fixtures, filter calls (fake search captures args), once-
per-source skip, vault-file skip, error containment; commit.

## Status notes

- The service gained the public `searchExactSections(request)` method this flow needs
  (ensureMemoryAccess + the shared offline discipline, via the extracted
  `searchClient()` guard `search` now shares).
- Polarity note: implemented per this file, "Never inject for reads of files inside
  vaults". The intercept fires for files OUTSIDE every registered vault
  (`classifyPath(listVaults(), absPath) !== null` skips). Flagged to the coordinating
  agent: the parent brief stated the opposite ("only inside a vault's markdown/").
- Tool name is the harness registry's lowercase `read` (verified live); `memory_read`
  never matches, which is the anti-loop coverage for the plugin's own tool.
- Guards, in order: name/agent/error, path resolution (relative paths against the
  session cwd), vault containment, per-turn path dedupe, 15 s throttle, cap of 6 per
  session (think-budget-independent), covered-directory skip. All search work is
  fire-and-forget; offline answers a silent skip plus one warning per install.
- One envelope per fire: a locality note naming the file being read, then the
  `wrapRecalled` sections; the provisioning notice rides as a separate first message
  when `ensureMemoryAccess` still holds one.
