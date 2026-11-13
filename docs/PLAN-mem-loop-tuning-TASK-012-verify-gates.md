# TASK-012: Full-repo gate pass and live-shape confirmation

Final verification across every task in this plan:

- `pnpm build` leaves the tree clean (`git status --porcelain` empty,
  verify-emit green across all six packages).
- `pnpm test` green; `pnpm test:coverage` clears the vitest.config.ts
  thresholds (85/85/78/85).
- `pnpm lint` clean.
- `prek run --files <every changed path>` clean.
- Re-run the fallback-agreement probe against
  `docs/research/eval-split-d078-s25-k60.json` and confirm the shipped
  constant reproduces it.
- Confirm the think-intercept module headers state the four new rules
  (written-source skip, all-vault intents, sleep, sentence query) and the
  search.ts headers state the two fallback-leg rules; each rule has one doc
  home.

Definition of Done: all gates green in one final state; a short note of any
deferred observation appended here for the parent agent.

Depends on: every prior task.
