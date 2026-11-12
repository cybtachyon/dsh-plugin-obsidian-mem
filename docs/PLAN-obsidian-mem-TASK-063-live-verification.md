# TASK-063 Live verification

Depends: TASK-062.

## Scope

- `cordis_inspect_query` host `Config.listConfigs` with `name: 'dsh-plugin-obsidian-mem'`
  → each row's `entry` schema present and matches declared Config (spot-check with
  `entry` queries).
- `Tool.listTools` shows `memory_read, memory_search, memory_write, memory_dream,
  memory_audit` (host inspect may scope to THIS agent — if the inspect agent predates
  install, note that tool visibility applies to newly created agents; state it honestly).
- Client `Slots.listSubTree` root `plugins.bundle.config` → occupant with our key (the
  page must be refreshed for client changes; ask the user or note it).
- Filesystem: before any memory access nothing exists (post-install check); after the
  first memory access: `$HOME/.dsh/obsidian-mem/{markdown,metadata}` + `.INTENTS.md`
  seeded, `$HOME/.dsh/obsidian-mem-db/memory.db` created, collection exists, and the tool
  result carried the one-time default-vault notice with the full path (Decision log).
- Behavior spot checks: run `memory_search` with a fixture note written via
  `memory_write` (write→search→read→audit cycle as the agent itself); confirm wrapper text,
  read-stats updated, audit report sane, read-only rejection with a temp read-only vault.
- Events (turn-start injection, read/think intercept, turn-end reminder): require a NEW
  session; ask the user to open one session and send one message, then inspect its log
  for `<recalled_memory` injections; if not observable, report verification limit.

## DoD

Written verification report (what passed, what is unverified + why) committed under
docs/research/verification-report.md; defects filed as new unchecked tasks in PLAN index.
