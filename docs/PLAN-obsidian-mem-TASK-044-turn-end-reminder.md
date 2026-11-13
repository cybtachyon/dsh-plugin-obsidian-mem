# TASK-044 Turn-end reminder

Status: done

Depends: TASK-040. `packages/events/src/turnEnd.ts`. Study how
dsh-longterm-memory subscribes to durable `turn/end` (`session/event` filtered on
`event.type === 'turn/end'`; there is NO Cordis `turn/start|end` event) and what
engramory-ext used to wake agents (followup vs inject).

## Scope

- CANONICAL (engramory-ext §2.5, docs/research/engramory-and-ext-findings.md): listen on
  `agent/turn-stopping` (agent bus, serial; NOT session/event) and deliver via
  `agent.steer(createUserMessage({content, source:{kind:'plugin:obsidian-mem',
  form:'notice'}}))`. A listener that steers keeps the turn open once; a per-turn
  `reminderFired` flag in a `WeakMap<Agent, state>` (dies with the agent, no disposal
  listener) makes it once-per-turn so the turn can never loop open. Declare the message
  `kind` via a `MessageSourceMap` module augmentation (Session v4 retired the generic
  'plugin' kind).
- Skip conditions: subagent sessions (Task-040 `isSubagent`); trivial turns (greeting list
  or subject ≤ 24 chars unless it matches /[/\\`]/, the WORK_MARKER rule); turns that
  already called any memory_* tool (observe via `tools/result`). Ext rejected
  `tools/post-execute` additionalContexts: a tool-less turn is exactly when the reminder
  matters.
- Reminder body: the VERBATIM block from the project spec (see PLAN task body below) with
  `/absolute/path/to/first/shared/vault/.INTENTS.md` replaced by the real path.

  ```
  1. When you have learned something durable worth knowing in a future session: confirm it isn't already in the repo / git / AGENTS.md and isn't a secret value. Don't duplicate the source of truth.
  2. Use the `memory_search` tool and update an existing note rather than duplicate; otherwise write one atomic markdown file (one fact) with the `memory_write` tool.
  3. New memories go in the most related shared vault.
  4. The memory must carry a Why: line and a How to apply: line in the body.
  5. Archive memories that turn out wrong with the `memory_write` tool.
  6. Never store secret values, only where they live.
  7. Evaluate your turn and find instances where existing memories would have assisted you.
  Check if there were any significant patterns in your language that would indicate a use for the memory,
  then update <FIRST_SHARED_VAULT>/.INTENTS.md with those intent(s).
  8. Run the `memory_audit` tool.
  ```

## DoD

turn/end fixture triggers exactly one followup with the verbatim text + real path;
subagent sessions skipped; duplicate turn events deduped; commit.
