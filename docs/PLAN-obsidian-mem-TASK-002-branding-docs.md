# TASK-002 Branding, docs, display metadata

Depends: TASK-001.

## Scope

- `README.md`: user-facing overview. Obsidian Mem uses markdown vaults as shared agent
  memory; frictionless human-editable working wikis; Milvus-Lite vector recall; tools
  memory_read/search/write/dream/audit; shared vs read-only vaults; works out of the box:
  with no shared vault configured, a default vault at `$HOME/.dsh/obsidian-mem/` is
  created on FIRST memory access (not at install) and the agent is told so with the full
  path; DB at `$HOME/.dsh/obsidian-mem-db/`; config knobs table; uv
  auto-spawn note; model prefetch script note.
- `AGENTS.md`: copy local-infer's structure and code style sections, rewrite Architecture for
  this plugin's packages {core,service,ui,tools,events,client,bundle}, dev env tips (no
  codegraph here; use grep/read), build/test/lint commands, client card pipeline notes, the
  lib-tracking difference (lib untracked here), DSH event facts learned (no turn/start event;
  turn/end is a session-log event; agent/request cannot mutate messages; agent.inject() is
  the per-agent context channel; ToolRuntime.register definition shape).
- `locale/en.json` `{ "meta": { "title": "Obsidian Mem", "description": "..." } }` describing
  the shared-markdown-vault memory capability. (Single locale; document omission in final
  report.)
- `icon.svg`: original glyph (vault/book + vector nodes), <=256 KiB, inside package.
- LICENSE: MIT (holder: Derek / project authors).

## DoD

Files exist, valid JSON/SVG, title/description meaningful; commit.
