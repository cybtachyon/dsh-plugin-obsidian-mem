# TASK-062 Install bundle into profile

Depends: TASK-061. Per cordis-plugin-development skill: `plugin_manager`
`action: install_bundle`, `target: /home/derek/src/dsh-plugin-obsidian-mem` (absolute dir).

## Scope

- `pnpm build` fresh first (installed files come from the tree).
- If the tool reports `pendingBuilds`, STOP and report to the parent (user approval
  required; do not pass approvedBuilds unilaterally).
- Read the result: `application` + `warnings` decide liveness. Replacing an already
  installed package needs host restart — if the live host must restart, report it rather
  than claiming liveness.
- Confirm rows appear: `plugin_manager list_plugins` (profile-scoped) and then use
  cordis_inspect_query (approval-free) for liveness.

## DoD

Install returns applied (or restart-required, reported); rows visible; commit nothing
(repo unchanged) — this task's artifact is the installed profile.
