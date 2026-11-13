# TASK-004 service-provisioning-registry

Objective: carry the new layout and `globalFile` through the service seam in
`packages/service/src/service.ts` per
[PLAN-vault-layout.md](../PLAN-vault-layout.md).

Files: `packages/service/src/service.ts`, service specs touching provisioning,
`addVault`, registry load/persist.

Steps:
1. Provisioning pass: stop `mkdirp(markdownDir(...))`; create vault root +
   `metadataDir` (the core helper now points at `.obsidian-mem/metadata`).
2. `addVault`: accept `globalFile` on `VaultAddRequest` (validated like
   TASK-003 rules or defaulted to `GLOBAL_MEMORY_FILE_DEFAULT`); provision
   root + metadataDir for shared vaults; store `globalFile` on `VaultEntry`.
3. Registry: `VaultEntry` extends the core `VaultConfig`, so `globalFile`
   flows; settings-row vaults take it from the resolved config; persisted
   `state/vaults.json` entries gain `globalFile`, and loading a pre-existing
   file without the key defaults it (backward compatible).
4. `status()`/`listVaults()` echo `globalFile` (the card rows read it).
5. Every remaining `markdownDir` import/call in service.ts disappears.

Definition of Done: service specs cover addVault default/blank/explicit
`globalFile`, vaults.json round-trip with and without the key; `pnpm build`
clean; emit committed with the change.

Depends on: R1.
