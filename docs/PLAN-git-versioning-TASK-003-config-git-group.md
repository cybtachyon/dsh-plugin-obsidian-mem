# TASK-003-config-git-group

Add the `git` config group to the plugin Config (service/config.ts), card
whitelist, and settings persistence.

Scope (Q4 answer: card-editable churn knobs): the CARD carries three git
knobs: `git.enabled` (checkbox "Use Git to version shared vaults",
default true), `git.churnThresholdPercent` (default 50), and
`git.churnWindowCommits` (default 8). The TASK-002 core constants supply
these config defaults only; every consumer reads the RESOLVED config.

Schema changes (`packages/service/src/config.ts`):
- `ObsidianMemConfig.git?: { enabled?: boolean; churnThresholdPercent?: number; churnWindowCommits?: number }`;
  mirrored required in `ObsidianMemResolvedConfig` /
  `ResolvedObsidianMemConfig`.
- `defaults()`: `git: { enabled: true, churnThresholdPercent: DEFAULT_CHURN_THRESHOLD_PERCENT, churnWindowCommits: DEFAULT_CHURN_WINDOW_COMMITS }`.
- `TOP_KEYS` += `'git'`; `collectUnknown` for the group; validate
  `git.enabled` as a boolean (same shape as the `llm.enabled` branch),
  `git.churnThresholdPercent` as an integer in (0, 100],
  `git.churnWindowCommits` as a positive integer (truncate like the
  budgets loop).
- `CARD_SETTINGS_KEYS` += `'git.enabled'`, `'git.churnThresholdPercent'`,
  `'git.churnWindowCommits'`; `CardEditableConfig` +=
  `git: { enabled: boolean; churnThresholdPercent: number; churnWindowCommits: number }`
  (the settings tests pin the list against the interface).
- Card-settings override merge (`card-settings.ts`) picks the group up
  through the generic leaf machinery; verify the merge and reset-all paths
  in `tests/card-settings.spec.ts`.
- Config idempotence rule (memory note): a fully resolved config must
  re-validate without issues.

Definition of Done:
- config.spec.ts: default `{}` yields `git.enabled === true`,
  `git.churnThresholdPercent === 50`, `git.churnWindowCommits === 8`;
  mounted values survive; wrong types / out-of-range churn values report
  issues at their paths; resolved-config re-validation idempotence covers
  the new group.
- card-settings.spec.ts pin updated (CARD_SETTINGS_KEYS ↔
  CardEditableConfig lockstep).
- Build + service suite green; src+lib committed together.
