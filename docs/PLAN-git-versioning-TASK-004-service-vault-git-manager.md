# TASK-004-service-vault-git-manager

Wire `MemoryGit` into `ObsidianMemService` for SHARED vaults only
(`packages/service/src/service.ts`; new `packages/service/src/vault-git.ts`
if the class deserves its own home, it does).

Design (adapted from the reference seam, see the brief):
- `VaultGitManager` holds one `MemoryGit` per registered SHARED vault path,
  created lazily; `MemoryGitOptions.extraIgnorePaths` never needed (each
  repo root IS the vault root) but the ignore file must cover
  `.obsidian-mem/` (core `PLUGIN_VAULT_DIR`) via TASK-001's adapted text.
- Adoption (`ensureRepo`) runs only when `config.git.enabled`:
  - in `ensureMemoryAccess()` after provisioning, for every shared vault
    whose directory exists (live-store guardrail: never git-init an absent
    root; log the same way the reference logs
    "auto-commit stays off: ... does not exist");
  - in `addVault` for a new shared vault (after `commitRegistryMutation`);
  - idempotent and cheap; failures `log.error` and leave the vault
    unmanaged (warn-don't-die; a later call retries through the same
    ensureRepo).
- `commitVault(vaultPath, message): Promise<string | null>`: no-op null
  when git is disabled or the vault is not shared; serialized per vault
  through the existing `serial-queue.ts` seam so concurrent writes cannot
  race two `add -A`+`commit` pairs; commit failure logs and rethrows as a
  settled `null` decision only for the expected git outcomes the wrapper
  already absorbs.
- `commitAllShared(message)`: one pass over shared vaults (dream end).
- `logShared(vaultPath, count)` / `statusShared(vaultPath)` read-only
  accessors for the audit (TASK-008); read-only vaults are never
  touched by any git method (guard in the manager, one place).
- The wrapper's identity fallback (TASK-001) is what makes a bare machine
  committable; document it at the manager constructor (decide-at-builder,
  deviates from the reference which relies on user git config).

Tests (`packages/service/tests/vault-git.spec.ts` + wiring assertions in
`service.spec.ts`): fake `GitRunner` injected via hooks
(`ObsidianMemHooks` gains a `gitRunner?` factory seam so no spec forks the
binary except one integration case). Pin: git disabled touches nothing;
read-only vault never gets a MemoryGit; ensureRepo failure logged, service
keeps serving; per-vault serialization (two queued commits land in call
order); commitAllShared skips non-shared and clean trees.

Definition of Done: build + service suite green; src+lib committed
together.
