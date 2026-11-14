/**
 * `VaultGitManager`: the one place that decides which vaults are git-versioned
 * and when they are committed. It holds one core {@link MemoryGit} per
 * registered SHARED vault path (created lazily, never for a `read-only`
 * vault), gates every move on the LIVE `config.git.enabled` value read at
 * call time (the card swaps the config group mid-session, so nothing here may
 * capture the gate at boot), and serializes each vault's git work through its
 * own {@link SerialQueue} so concurrent writes cannot race two
 * `add -A`+`commit` pairs against one history.
 *
 * Failure policy is warn-don't-die everywhere: an absent vault root logs
 * (like the reference plugin's "auto-commit stays off") and is never
 * git-init'ed; a failing `ensureRepo` logs and leaves the vault unmanaged so
 * the next call retries through the same seam; a failing commit logs and
 * answers a settled `null`. No public method ever rejects: git is the history
 * book, the memory files are the source of truth.
 * @module dsh-plugin-obsidian-mem/service/vault-git
 */
import type { GitRunner, MemoryGitCommit, MemoryGitStatus } from '../../core/lib/index.js';
/** The plugin-logger slice the manager consumes. */
export interface VaultGitLog {
    warn(message: string): void;
    error(message: string): void;
}
/** One shared vault's outcome inside a {@link VaultGitManager.commitAllShared} pass. */
export interface VaultGitCommitOutcome {
    /** The vault root the commit ran (or was refused) at. */
    vault: string;
    /** The new commit's full hash, or null when nothing was recorded. */
    hash: string | null;
}
/** Construction seams for {@link VaultGitManager}; the service supplies all of them. */
export interface VaultGitManagerOptions {
    /**
     * The git gate, read at every call so a card flip takes effect on the
     * next call (never capture the value at boot).
     */
    gitEnabled: () => boolean;
    /** The currently registered SHARED vault roots, in registry order. */
    sharedVaults: () => readonly string[];
    /** Directory existence probe (the service fs seam); adoption never inits an absent root. */
    exists: (path: string) => boolean;
    /** git process boundary per vault root; default forks the real binary there. */
    gitRunner?: (root: string) => GitRunner;
    log: VaultGitLog;
}
/**
 * VaultGitManager versions the SHARED vaults and nothing else: the
 * read-only-mode guard, the enabled gate, and the one-MemoryGit-per-vault
 * Map all live here so no caller can fork the policy.
 *
 * Decide-at-builder note (a deliberate deviation from the reference plugin,
 * which relies on the user's git config): the manager builds every
 * `MemoryGit` with default options, so the wrapper's commit-identity
 * fallback stays on and a bare machine with no `user.name`/`user.email`
 * configured can still record memory history.
 */
export declare class VaultGitManager {
    private readonly handles;
    private readonly lanes;
    private readonly absentWarned;
    private readonly gitEnabled;
    private readonly sharedVaults;
    private readonly exists;
    private readonly gitRunner;
    private readonly log;
    constructor(options: VaultGitManagerOptions);
    /**
     * EnsureSharedVaults adopts every registered shared vault: the
     * provisioning-pass seam (ensureMemoryAccess calls it after the registry
     * is final). Idempotent and cheap on healthy repos. Never rejects; a
     * vault the git layer cannot adopt stays unmanaged.
     */
    ensureSharedVaults(): Promise<void>;
    /**
     * EnsureVault adopts one freshly added shared vault (the addVault seam).
     * A read-only add or a disabled gate no-ops inside the guard, so the
     * caller never re-checks the policy.
     */
    ensureVault(vaultPath: string): Promise<void>;
    /**
     * CommitVault records every current change in one shared vault as one
     * commit and answers the new hash: null (no throw) when git is disabled,
     * the vault is not shared, adoption cannot succeed, or the tree is
     * clean. The vault's lane serializes the pair against concurrent writes;
     * an unmanaged vault is adopted lazily here, which is how a
     * disabled-to-enabled flip lets the next write commit.
     * @param vaultPath - a registered vault root; anything else no-ops.
     * @param message - the commit message to record.
     */
    commitVault(vaultPath: string, message: string): Promise<string | null>;
    /**
     * CommitAllShared runs one commit pass over every shared vault (the dream
     * end seam) and answers each vault's outcome; clean trees come back as
     * null hashes. A disabled gate answers the empty list.
     * @param message - the commit message shared by the pass.
     */
    commitAllShared(message: string): Promise<VaultGitCommitOutcome[]>;
    /**
     * LogShared answers the newest `count` commits of one managed shared
     * vault (the audit churn input); null when git cannot answer (disabled,
     * not shared, never adopted, or a failed read).
     */
    logShared(vaultPath: string, count: number): Promise<MemoryGitCommit[] | null>;
    /**
     * StatusShared answers the working-tree summary of one managed shared
     * vault (the audit git rollup input); null under the same conditions as
     * {@link VaultGitManager.logShared}.
     */
    statusShared(vaultPath: string): Promise<MemoryGitStatus | null>;
    /**
     * AdoptedRoots lists the shared vault roots currently git-managed. The
     * list is gated against the live shared registry, so a removed vault
     * drops out even before {@link VaultGitManager.forget} runs.
     */
    adoptedRoots(): string[];
    /** Forget drops a vault's handle and lane after removeVault; a later re-add starts unmanaged. */
    forget(vaultPath: string): void;
    private isShared;
    private managedGit;
    private readShared;
    private ensureAdopted;
    private laneFor;
}
//# sourceMappingURL=vault-git.d.ts.map
