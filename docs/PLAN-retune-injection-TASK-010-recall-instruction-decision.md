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

# Decision record (2026-11-13): DEFER, no follow-on task

NO-GO on the post-recalled_memory instruction line for this plan, per plan
answer A5: defer; implement only if a Phase-3 live-loop iteration shows
relevant-but-not-injected notes a tool call would have found. No follow-on
implementation task is added to PLAN-retune-injection.md; the reopen watch
(§5) and the Phase-3 ledger watch (§6) live here, and
`docs/PLAN-retune-injection-TASK-013-live-loop-iteration.md` already lists
TASK-010 as a dependency. No code changes. Facts re-verified against HEAD
7c05c3e before recording.

Context from TASK-005's numbers (stopword-strip-findings.md, shipped
strip-ON page): forbidden-rate 0.294, recall-of-labeled 15/24 = 0.625
(achievable 15/22 = 0.682 once the three unsatisfiable labels are
excluded). A relevant-but-not-injected population therefore exists
offline; A5's gate is the live question of whether a topic-driven tool
call would have retrieved those notes AND the agent did not self-serve.

## 1. The mechanism already in place (verified in code)

`guidanceLine` in `packages/events/src/turnStart.ts:257-268` builds the
line "Use memory_search for the file types, coding languages, or
frameworks you discover in this workspace: ..." from the deduped union of
the manifest's `topExtensions`, `languages`, and `frameworks`, and
returns `''` when nothing was discovered (shape pinned by
`packages/events/tests/turnStart.spec.ts:367-393`). The undecided item
would not replace this line; it would stack a second, per-session topic
restatement on top of it (the task text: "before or merged with the
existing guidance line").

- Injected last: the flow loops the recall bodies first ("Recall bodies
  first, so the guidance line reads last.", turnStart.ts:167; loop
  :168-171; guidance :172-177). Order pins: notice, pinned global, search
  recall, guidance (turnStart.spec.ts:236, :486). The whole flow runs
  once per session (`markTurnStartDone` gate, turnStart.ts:110-113), so
  the GO branch would add one line per session, not per turn.
- It rides even with zero recall: no user text searches nothing, and the
  guidance line is the flow's sole injection (turnStart.spec.ts:327-346).
- Budget-counted: `injectNotice` returns the block's `approxTokens` cost
  (`packages/events/src/toolkit.ts:175-183`), the guidance cost
  accumulates into the flow total (turnStart.ts:175), and
  `registry.addRecallTokens(sessionId, injectedTokens)` books it (
  turnStart.ts:179); the spec "accounts every injected token into the
  session registry" sums every injected message including guidance
  (turnStart.spec.ts:355-364).
- Uncapped at injection time: the `budgets.turnStartRecallTokens` trim
  (default 1200, `packages/core/src/constants.ts:262`,
  config.ts:87/:161) bounds only the search blocks
  (`budgetedRecallSources`, turnStart.ts:188-214). The guidance line,
  and any GO-branch line, ride after that trim unconditionally and touch
  only the global cumulative counter.

## 2. Global budget economics (verified in code, corroborated in vault)

- `budgets.globalMemoryTokens` is a plugin Cordis config knob
  (`packages/service/src/config.ts:88`, resolved :113/:162) defaulting
  to core `GLOBAL_MEMORY_TOKENS = 1500`
  (`packages/core/src/constants.ts:268`).
- The counter is injection accounting: `addRecallTokens`
  (`packages/events/src/sessions.ts:418-423`) per session, summed across
  live sessions by `totalRecallTokensUsed()` (sessions.ts:430-437). The
  window is "tokens injected since the last successful dream or host
  restart": a successful dream post-pass calls `resetRecallUsage()`
  (sessions.ts:440-447; window phrase in `compactionInstruction`,
  `packages/events/src/budget.ts:34-44`).
- The gate is strictly-over (flip at cap + 1):
  `isOverGlobalBudget` (`packages/core/src/budget.ts:22-24`); over it,
  the turn-start flow returns early before pinned-global, search recall,
  AND guidance (turnStart.ts:143-147). Token math is
  `approxTokens = ceil(chars / 4)` (constants.ts:331).
- Vault corroboration (read 2026-11-13):
  `~/.dsh/obsidian-mem/obsidian-mem-global-budget-number-is-injected-tokens-cumulative-not-note-size.md`
  (the ONE number is cumulative injected tokens, reset by a successful
  dream, every surface names the same window) and
  `~/.dsh/obsidian-mem/obsidian-mem-subagent-zero-recall-is-budget-not-gating.md`
  (measured: the parent GUI session burns the window in one flow, 1594
  tokens at once, later transcripts "3869 of 1500"; a subagent's zero
  turn-start recall is the budget, not gating; think/read-intercept
  recalls are NOT global-budget gated). Consequence for any added line:
  the window's headroom past the first big session is the only way a
  later session, such as a probe subagent, gets a turn-start package at
  all.

## 3. Cost per candidate line (measured with the production approxTokens)

Method: the built `packages/core/lib` + `packages/events/lib` ran
`scanManifest` + `guidanceLine` on the real Phase-3 testbed
`/home/derek/src/machinae-game` (manifest: extensions
ts/json/xml/md/html/iml/yaml, languages javascript/typescript, framework
vite), and `extractTriggers` on six real vault notes for the wake-keyword
population. LLM trigger refinement defaults OFF
(`packages/service/src/config.ts:183`) and no vault note carries a
frontmatter `keywords:` override, so today's indexed wake_keywords are
the core heuristics.

| candidate | chars | approxTokens |
| --- | --- | --- |
| existing guidance line, machinae-game manifest (10 terms) | 174 | 44 |
| topic restatement, terse boilerplate + 3 topics | 65 | 17 |
| topic restatement, full boilerplate + 3 topics | 111 | 28 |
| topic restatement, full boilerplate + 6 topics (4-note wake union) | 195 | 49 |

- Per-session cost is one line: about 17-49 tokens, 1-3% of the 1500
  window per session; merged into the existing line, the marginal cost
  is the topic payload only (4-25 tokens measured).
- The topic vocabulary is weak today: heuristic wake_keywords measured
  3-6 terms per note and were dominated by intent markers ("when",
  "how", "why"). A restatement of the current wake population mostly
  re-broadcasts function words, which is the request's named
  "token-wasting noise agents ignore" risk in concrete form.
- Cap hazard: indexed wake_keywords may hold 96 elements of 64 chars
  each (`packages/core/src/constants.ts:384-398`). A line restating a
  wake union with no cap of its own could single-handedly spend the
  entire 1500-token window.

## 4. What the GO branch would pay, and what it displaces

- Frequency: one line per session (§1), roughly 20-50 tokens.
- Displacement is on the global counter, not the current page: search
  recall is already trimmed to 1200 before the line rides (§1), so the
  line never thins the session it joins; it pushes that session's total
  toward 1500, where every later session's entire turn-start package
  (pinned GLOBAL.md + up to 1200 tokens of search recall + the guidance
  line) is suppressed at once (§2).
- In practice the window dies at the first big GUI session (measured
  1594 tokens); the marginal line trims exactly the headroom that would
  otherwise let one more session get a turn-start package. At the
  measured 44-token shape, about 34 lines equal one fully displaced
  1500-token window.
- It is also the third standing memory_search nudge: the guidance line,
  the tools system-prompt section ("Before starting real work on a
  project or task, memory_search the vault",
  `packages/tools/src/prompt.ts:51-53`, free of recall budget since it
  is a system-prompt section), and the tool description. Evidence the
  nudge channel is already open: every session in this very plan
  (including this subagent) received recalled_memory blocks plus the
  prompt section and used memory tools without a topic restatement.

## 5. Reopen trigger (exact)

Reopen the decision only on a TASK-013 ledger row that records ALL of:

(a) names one note relevant to the subagent's task (a seeded-relevant
    from TASK-011, or a pre-existing relevant note);
(b) it was NOT injected to that subagent by any of the three intercepts
    (turn-start, think, read): confirmed twice, by the subagent's
    send_message reports AND its session transcript
    (`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`,
    user/message records with source.kind `plugin:obsidian-mem`);
(c) an actually-run `memory_search` with the note's topic / wake-word
    query retrieved it (record the query string and the rank returned);
(d) the subagent transcript contains no self-initiated
    `memory_search` tool/call that could have retrieved it (count
    tool/call records only; per the `dsh-session-transcript-probe`
    vault note, instruction or recalled text mentioning the tool is not
    evidence of use);
(e) the session's turn-start flow was not global-budget suppressed: no
    "budget is spent (X of 1500 ...)" turn-end steer line in that
    session.

Clause (e) refines A5's wording on purpose: A5's "relevant-but-not-
injected" must exclude suppression-caused misses, because a suppressed
session's miss is a budget/loop-design artifact that TASK-014's converge
step fixes, and the instruction line could never cure it.

## 6. What the Phase-3 ledgers must explicitly watch for

Beyond the existing TASK-013 table (iteration / relevant hit / decoy hit
/ forbidden / misses / notes), every iteration records:

- For each useful-but-missed note (already a TASK-013 step-4
  population): the topic-driven `memory_search` run afterwards, its
  exact query, whether it retrieved the missed note, at what rank; and
  the subagent's self-serve rate, the count of `memory_search`
  tool/calls the subagent issued unprompted. The GO branch only pays off
  where retrieval works AND self-serve failed; misses a prompt-section
  self-serve would have covered are not reopen evidence.
- Per observed session, the budget state beside recall presence: did
  turn-start recall fire, and the turn-end steer "X of 1500" number
  when over. Between iterations dispose the subagent sessions (already
  TASK-013 step 5) and apply the vault note's loop-design fixes (probe
  first after restart, or temporarily raise
  `budgets.globalMemoryTokens`), so zero-recall rows never contaminate
  this watch.
- The noise baseline: whether any session demonstrably acted on the
  existing guidance line at all. That base rate is what any additional
  nudge gets judged against, and it costs nothing to observe.

## 7. Implementation shape if reopened (no code now)

Add a follow-on implementation task to PLAN-retune-injection.md first,
scoped to: topics drawn only from the wake_keywords of the sources this
session actually injected, deduped and capped (order of 10 terms /
~40 `approxTokens`); merged into the existing guidance line rather than
a third message; cost booked through `injectNotice` like every other
line (§1); then A/B in the live loop against the §6 ledger columns. It
ships only if §5 trigger rows persist and the A/B shows topic-driven
tool calls landing notes the injected page missed.
