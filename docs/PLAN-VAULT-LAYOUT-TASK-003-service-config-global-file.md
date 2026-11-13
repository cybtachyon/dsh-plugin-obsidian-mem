# TASK-003 service-config-global-file

Objective: teach the plugin Config schema the per-vault `globalFile` field per
[PLAN-vault-layout.md](../PLAN-vault-layout.md) "Config model change".

Files: `packages/service/src/config.ts`, service config specs.

Steps:
1. `ObsidianMemConfig.vaults` entry: add optional `globalFile?: string`;
   resolved entries carry `globalFile: string`.
2. Validation: when present it must be a non-empty string with no leading `/`
   and no `..` segment (vault-root-relative path, e.g. `GLOBAL.md`); blank or
   omitted resolves to `GLOBAL_MEMORY_FILE_DEFAULT`.
3. Add `'globalFile'` to the vault-entry known-keys list so it is not
   reported as an unknown key.
4. `resolveServiceConfig` keeps `globalFile` untouched (it is relative; only
   `path` expands `~`).

Definition of Done: config specs cover default, valid, and each invalid form;
`pnpm build` clean; emit committed with the change.

Depends on: TASK-002 (constant), Questionnaire Q3 answer.
