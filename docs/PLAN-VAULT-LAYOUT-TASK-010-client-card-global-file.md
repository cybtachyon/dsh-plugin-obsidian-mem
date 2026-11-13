# TASK-010 client-card-global-file

Objective: the Obsidian Mem settings card collects the new per-vault field on
the add-vault row.

Files: `packages/client/src/sections/vaults.tsx`, `packages/client/src/api.ts`,
rebuilt `dsh/client.js`.

Steps:
1. Add form gains a third input with placeholder exactly:
   `Global memory relative file path e.g. GLOBAL.md`
   (title hint: optional; relative to the vault root; blank defaults to
   GLOBAL.md). Blank input is omitted from the POST body (host default).
2. `AddVaultRequest` gains optional `globalFile: string`; sent only when the
   trimmed value is non-empty.
3. Registry rows display the vault's `globalFile` (the status payload echoes
   it) as a quiet tag so users see the effective default.
4. Rebuild the card artifact: `pnpm build` regenerates `dsh/client.js`;
   commit it (tracked).

Definition of Done: card specs (section/api pure parts) cover the input and
payload; `pnpm build` exits clean incl. build-client + verify-emit; emit +
`dsh/client.js` committed with the change.

Depends on: TASK-009.
