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
import { MemoryGit, createGitRunner } from '../../core/lib/index.js';
import { describeError } from './errors.js';
import { createSerialQueue } from './serial-queue.js';
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
export class VaultGitManager {
    // Managed vault roots and their handle. An entry lands only while
    // ensureRepo succeeds; a failed adoption deletes it so the next call
    // retries through the same seam.
    handles = new Map();
    // One serialization lane per vault root; git mutates one history at a
    // time and two lanes must never interleave one vault's add+commit pair.
    lanes = new Map();
    // Vault roots whose absence has already produced the "stays off" warn,
    // so a per-write commit path does not re-log a still-missing directory.
    absentWarned = new Set();
    gitEnabled;
    sharedVaults;
    exists;
    gitRunner;
    log;
    constructor(options) {
        this.gitEnabled = options.gitEnabled;
        this.sharedVaults = options.sharedVaults;
        this.exists = options.exists;
        this.gitRunner = options.gitRunner ?? ((root) => createGitRunner(root));
        this.log = options.log;
    }
    /**
     * EnsureSharedVaults adopts every registered shared vault: the
     * provisioning-pass seam (ensureMemoryAccess calls it after the registry
     * is final). Idempotent and cheap on healthy repos. Never rejects; a
     * vault the git layer cannot adopt stays unmanaged.
     */
    async ensureSharedVaults() {
        if (!this.gitEnabled())
            return;
        for (const vaultPath of this.sharedVaults()) {
            await this.laneFor(vaultPath)(async () => {
                await this.ensureAdopted(vaultPath);
            });
        }
    }
    /**
     * EnsureVault adopts one freshly added shared vault (the addVault seam).
     * A read-only add or a disabled gate no-ops inside the guard, so the
     * caller never re-checks the policy.
     */
    async ensureVault(vaultPath) {
        if (!this.gitEnabled() || !this.isShared(vaultPath))
            return;
        await this.laneFor(vaultPath)(async () => {
            await this.ensureAdopted(vaultPath);
        });
    }
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
    async commitVault(vaultPath, message) {
        if (!this.gitEnabled() || !this.isShared(vaultPath))
            return null;
        return await this.laneFor(vaultPath)(async () => {
            const git = await this.ensureAdopted(vaultPath);
            if (git === null)
                return null;
            try {
                return await git.commitAll(message);
            }
            catch (error) {
                // The memory write already landed; git staying a commit behind is recoverable.
                this.log.error(`git commit failed for vault ${vaultPath}: ${describeError(error)}`);
                return null;
            }
        });
    }
    /**
     * CommitAllShared runs one commit pass over every shared vault (the dream
     * end seam) and answers each vault's outcome; clean trees come back as
     * null hashes. A disabled gate answers the empty list.
     * @param message - the commit message shared by the pass.
     */
    async commitAllShared(message) {
        if (!this.gitEnabled())
            return [];
        const outcomes = [];
        for (const vaultPath of this.sharedVaults()) {
            outcomes.push({ vault: vaultPath, hash: await this.commitVault(vaultPath, message) });
        }
        return outcomes;
    }
    /**
     * LogShared answers the newest `count` commits of one managed shared
     * vault (the audit churn input); null when git cannot answer (disabled,
     * not shared, never adopted, or a failed read).
     */
    async logShared(vaultPath, count) {
        const git = this.managedGit(vaultPath);
        if (git === null)
            return null;
        try {
            return await git.log(count);
        }
        catch (error) {
            this.log.warn(`git log failed for vault ${vaultPath}: ${describeError(error)}`);
            return null;
        }
    }
    /**
     * StatusShared answers the working-tree summary of one managed shared
     * vault (the audit git rollup input); null under the same conditions as
     * {@link VaultGitManager.logShared}.
     */
    async statusShared(vaultPath) {
        const git = this.managedGit(vaultPath);
        if (git === null)
            return null;
        try {
            return await git.status();
        }
        catch (error) {
            this.log.warn(`git status failed for vault ${vaultPath}: ${describeError(error)}`);
            return null;
        }
    }
    /**
     * AdoptedRoots lists the shared vault roots currently git-managed. The
     * list is gated against the live shared registry, so a removed vault
     * drops out even before {@link VaultGitManager.forget} runs.
     */
    adoptedRoots() {
        if (!this.gitEnabled())
            return [];
        const shared = new Set(this.sharedVaults());
        return [...this.handles.keys()].filter((root) => shared.has(root));
    }
    /** Forget drops a vault's handle and lane after removeVault; a later re-add starts unmanaged. */
    forget(vaultPath) {
        this.handles.delete(vaultPath);
        this.lanes.delete(vaultPath);
        this.absentWarned.delete(vaultPath);
    }
    // IsShared is the manager's single SHARED-only guard: the service feeds
    // it the shared registry enumeration, so a read-only path can never pass.
    isShared(vaultPath) {
        return this.sharedVaults().includes(vaultPath);
    }
    // The read-accessor gate: enabled, shared, and already adopted. Reads
    // never adopt (the audit must not spawn git work as a side effect).
    managedGit(vaultPath) {
        if (!this.gitEnabled() || !this.isShared(vaultPath))
            return null;
        return this.handles.get(vaultPath) ?? null;
    }
    // EnsureAdopted converges one vault onto a managed handle. Call it only
    // inside the vault's lane. Absent roots log once (the live-store
    // guardrail: never git-init a directory that does not exist) and failed
    // adoptions delete the handle so the vault stays unmanaged and retryable.
    async ensureAdopted(vaultPath) {
        const managed = this.handles.get(vaultPath);
        if (managed !== undefined)
            return managed;
        if (!this.exists(vaultPath)) {
            if (!this.absentWarned.has(vaultPath)) {
                this.absentWarned.add(vaultPath);
                this.log.warn(`auto-commit stays off: vault ${vaultPath} does not exist`);
            }
            return null;
        }
        let git = this.handles.get(vaultPath);
        if (git === undefined) {
            git = new MemoryGit(vaultPath, this.gitRunner(vaultPath));
            this.handles.set(vaultPath, git);
        }
        try {
            await git.ensureRepo();
            return git;
        }
        catch (error) {
            this.handles.delete(vaultPath);
            this.log.error(`git adoption failed for vault ${vaultPath}; the vault stays unmanaged: ${describeError(error)}`);
            return null;
        }
    }
    // LaneFor returns the vault's serialization lane, creating it on first use.
    laneFor(vaultPath) {
        let lane = this.lanes.get(vaultPath);
        if (lane === undefined) {
            lane = createSerialQueue();
            this.lanes.set(vaultPath, lane);
        }
        return lane;
    }
}
//# sourceMappingURL=vault-git.js.map
