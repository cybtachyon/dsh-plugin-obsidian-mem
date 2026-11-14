# TASK-008-audit-service-churn-checkpoint

Service audit engine (`packages/service/src/audit.ts`): add the
`checkpoint` view and git churn per note row. Audit stays strictly
read-only (git reads are `log`/`status` only; the spec that asserts no fs
mutation across an audit call must stay green).

1. Views: `AUDIT_VIEWS = ['full', 'topStale', 'oldestUnread', 'checkpoint']`;
   `checkpoint` rows and ordering are identical to `full` (the view exists
   so the tool layer appends the checkpoint instructions; nothing else
   changes).
2. Churn input: `AuditDeps` gains an injected read-only git reader,
   `gitHistory: () => Array<{ vaultPath: string, commits: MemoryGitCommit[] }> | Promise<...>`
   supplied by the service (TASK-004 manager's `logShared` with window
   `config.git.churnWindowCommits`; empty array when git is disabled).
   Per-vault `churnByPath`; a note's churn is looked up by
   (vaultPath, rel). Rows carry `churn: number` (0 when untouched or no
   history), same semantics as the reference (share of the window that
   touched it).
3. Git rollups on `AuditReport.stats`:
   `git: Array<{ vault: string, initialized: boolean, clean: boolean | null, headHash: string | null, error: string | null }>`
   for every SHARED vault (read-only vaults never appear). A git command
   failure degrades that vault's entry to `{ error }` without failing the
   audit (reference `auditGit` degradation pattern).
4. Issues: add `git-not-adopted` INFO (shared vault registered and enabled
   but no repo) and `git-error` INFO lines from the rollup errors, each
   with the remediation "check the vault's git state; the Obsidian Mem
   card owns the Use Git toggle". No new ISSUE severities.

Tests (`audit.spec.ts`): checkpoint rows equal full rows for the same
store; churn fractions from a scripted commit list (young-store window);
per-vault git rollup degradation; disabled git yields churn 0 everywhere
and an empty rollup; read-only vaults absent from the git rollup; the
read-only-no-mutation assertion still passes.

Definition of Done: build + service suite green; src+lib committed
together.
