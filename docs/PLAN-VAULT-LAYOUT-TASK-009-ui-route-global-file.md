# TASK-009 ui-route-global-file

Objective: the vault route accepts and echoes `globalFile`.

Files: `packages/ui/src/index.ts` (route table + docs), ui specs.

Steps:
1. `POST /obsidian-mem/vaults`: optional body `globalFile` (non-empty
   string; invalid → same `vaultInvalid` 400 shape as `mode`); pass through
   into `VaultAddRequest`.
2. Route catalog `description` strings for GET/POST `/obsidian-mem/vaults`
   mention `{ path, mode, source, globalFile }`.
3. Status payload needs no change once service `VaultEntry` carries the
   field; confirm the status echo test sees it.

Definition of Done: ui specs pin accept/default/reject of `globalFile`;
`pnpm build` clean; emit committed with the change.

Depends on: TASK-008.
