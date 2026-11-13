# TASK-010 recall-instruction-decision

Undecided-2: "Injecting an instruction after the recalled_memory for the
agent to use the memory_search tool on the intent / wake_word topic."
Record the go/no-go.

Facts to weigh:
- A guidance line ALREADY exists at turn start
  (`guidanceLine` in packages/events/src/turnStart.ts): "Use memory_search
  for the file types, coding languages, or frameworks you discover in this
  workspace: ...". The undecided item would add a per-turn-start search
  TOPIC restatement.
- The risk named in the request: token-wasting noise agents ignore. Every
  injected line costs global recall budget
  (`GLOBAL_MEMORY_TOKENS = 1500`, and this session's own budget note in
  the vault).
- If implemented, measure it in the live loop: does any subagent actually
  issue a topic-driven memory_search call, and does it retrieve rows the
  automatic recall missed?

Decision: follow the Q5 answer (default RECOMMENDED: defer; implement only
if Phase-3 iterations show relevant-but-not-injected notes that a
tool-call would have found). If GO: implement in turnStart.ts after the
recall blocks (before or merged with the existing guidance line), count it
in token accounting like every other injectNotice, and A/B in the live
loop.

Definition of Done: decision + rationale written in this file; plan
updated with any follow-on task.

Depends on: TASK-005 (numbers), optionally TASK-013 observations when the
decision is revisited.
