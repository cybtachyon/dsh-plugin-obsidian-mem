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

import { MemoryGit, createGitRunner } from '../../core/lib/index.js'
import type { GitRunner, MemoryGitCommit, MemoryGitStatus } from '../../core/lib/index.js'
import { describeError } from './errors.js'
import { createSerialQueue } from './serial-queue.js'
import type { SerialQueue } from './serial-queue.js'

/** The plugin-logger slice the manager consumes. */
export interface VaultGitLog {
  warn(message: string): void
  error(message: string): void
}

/** One shared vault's outcome inside a {@link VaultGitManager.commitAllShared} pass. */
export interface VaultGitCommitOutcome {
  /** The vault root the commit ran (or was refused) at. */
  vault: string
  /** The new commit's full hash, or null when nothing was recorded. */
  hash: string | null
}

/** Construction seams for {@link VaultGitManager}; the service supplies all of them. */
export interface VaultGitManagerOptions {
  /**
   * The git gate, read at every call so a card flip takes effect on the
   * next call (never capture the value at boot).
   */
  gitEnabled: () => boolean
  /** The currently registered SHARED vault roots, in registry order. */
  sharedVaults: () => readonly string[]
  /** Directory existence probe (the service fs seam); adoption never inits an absent root. */
  exists: (path: string) => boolean
  /** git process boundary per vault root; default forks the real binary there. */
  gitRunner?: (root: string) => GitRunner
  log: VaultGitLog
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
export class VaultGitManager {
  // Managed vault roots and their handle. An entry lands only while
  // ensureRepo succeeds; a failed adoption deletes it so the next call
  // retries through the same seam.
  private readonly handles = new Map<string, MemoryGit>()
  // One serialization lane per vault root; git mutates one history at a
  // time and two lanes must never interleave one vault's add+commit pair.
  private readonly lanes = new Map<string, SerialQueue>()
  // Vault roots whose absence has already produced the "stays off" warn,
  // so a per-write commit path does not re-log a still-missing directory.
  private readonly absentWarned = new Set<string>()

  private readonly gitEnabled: () => boolean
  private readonly sharedVaults: () => readonly string[]
  private readonly exists: (path: string) => boolean
  private readonly gitRunner: (root: string) => GitRunner
  private readonly log: VaultGitLog

  constructor(options: VaultGitManagerOptions) {
    this.gitEnabled = options.gitEnabled
    this.sharedVaults = options.sharedVaults
    this.exists = options.exists
    this.gitRunner = options.gitRunner ?? ((root) => createGitRunner(root))
    this.log = options.log
  }

  /**
   * EnsureSharedVaults adopts every registered shared vault: the
   * provisioning-pass seam (ensureMemoryAccess calls it after the registry
   * is final). Idempotent and cheap on healthy repos. Never rejects; a
   * vault the git layer cannot adopt stays unmanaged.
   */
  async ensureSharedVaults(): Promise<void> {
    if (!this.gitEnabled()) return
    for (const vaultPath of this.sharedVaults()) {
      await this.laneFor(vaultPath)(async () => {
        await this.ensureAdopted(vaultPath)
      })
    }
  }

  /**
   * EnsureVault adopts one freshly added shared vault (the addVault seam).
   * A read-only add or a disabled gate no-ops inside the guard, so the
   * caller never re-checks the policy.
   */
  async ensureVault(vaultPath: string): Promise<void> {
    if (!this.gitEnabled() || !this.isShared(vaultPath)) return
    await this.laneFor(vaultPath)(async () => {
      await this.ensureAdopted(vaultPath)
    })
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
  async commitVault(vaultPath: string, message: string): Promise<string | null> {
    if (!this.gitEnabled() || !this.isShared(vaultPath)) return null
    return await this.laneFor(vaultPath)(async () => {
      const git = await this.ensureAdopted(vaultPath)
      if (git === null) return null
      try {
        return await git.commitAll(message)
      } catch (error: unknown) {
        // The memory write already landed; git staying a commit behind is recoverable.
        this.log.error(`git commit failed for vault ${vaultPath}: ${describeError(error)}`)
        return null
      }
    })
  }

  /**
   * CommitAllShared runs one commit pass over every shared vault (the dream
   * end seam) and answers each vault's outcome; clean trees come back as
   * null hashes. A disabled gate answers the empty list.
   * @param message - the commit message shared by the pass.
   */
  async commitAllShared(message: string): Promise<VaultGitCommitOutcome[]> {
    if (!this.gitEnabled()) return []
    const outcomes: VaultGitCommitOutcome[] = []
    for (const vaultPath of this.sharedVaults()) {
      outcomes.push({ vault: vaultPath, hash: await this.commitVault(vaultPath, message) })
    }
    return outcomes
  }

  /**
   * LogShared answers the newest `count` commits of one managed shared
   * vault (the audit churn input); null when git cannot answer (disabled,
   * not shared, never adopted, or a failed read).
   */
  async logShared(vaultPath: string, count: number): Promise<MemoryGitCommit[] | null> {
    return await this.readShared('log', vaultPath, (git) => git.log(count))
  }

  /**
   * StatusShared answers the working-tree summary of one managed shared
   * vault (the audit git rollup input); null under the same conditions as
   * {@link VaultGitManager.logShared}.
   */
  async statusShared(vaultPath: string): Promise<MemoryGitStatus | null> {
    return await this.readShared('status', vaultPath, (git) => git.status())
  }

  /**
   * AdoptedRoots lists the shared vault roots currently git-managed. The
   * list is gated against the live shared registry, so a removed vault
   * drops out even before {@link VaultGitManager.forget} runs.
   */
  adoptedRoots(): string[] {
    if (!this.gitEnabled()) return []
    const shared = new Set(this.sharedVaults())
    return [...this.handles.keys()].filter((root) => shared.has(root))
  }

  /** Forget drops a vault's handle and lane after removeVault; a later re-add starts unmanaged. */
  forget(vaultPath: string): void {
    this.handles.delete(vaultPath)
    this.lanes.delete(vaultPath)
    this.absentWarned.delete(vaultPath)
  }

  // IsShared is the manager's single SHARED-only guard: the service feeds
  // it the shared registry enumeration, so a read-only path can never pass.
  private isShared(vaultPath: string): boolean {
    return this.sharedVaults().includes(vaultPath)
  }

  // The read-accessor gate: enabled, shared, and already adopted. Reads
  // never adopt (the audit must not spawn git work as a side effect).
  private managedGit(vaultPath: string): MemoryGit | null {
    if (!this.gitEnabled() || !this.isShared(vaultPath)) return null
    return this.handles.get(vaultPath) ?? null
  }

  // ReadShared is the audit-read policy logShared and statusShared share:
  // the managedGit gate, the operation, and the warn-and-null failure rule.
  // `name` names the operation in the warn line.
  private async readShared<T>(
    name: string,
    vaultPath: string,
    op: (git: MemoryGit) => Promise<T>,
  ): Promise<T | null> {
    const git = this.managedGit(vaultPath)
    if (git === null) return null
    try {
      return await op(git)
    } catch (error: unknown) {
      this.log.warn(`git ${name} failed for vault ${vaultPath}: ${describeError(error)}`)
      return null
    }
  }

  // EnsureAdopted converges one vault onto a managed handle. Call it only
  // inside the vault's lane (no concurrent adoption can race this check).
  // Absent roots log once (the live-store
  // guardrail: never git-init a directory that does not exist) and failed
  // adoptions delete the handle so the vault stays unmanaged and retryable.
  private async ensureAdopted(vaultPath: string): Promise<MemoryGit | null> {
    const managed = this.handles.get(vaultPath)
    if (managed !== undefined) return managed
    if (!this.exists(vaultPath)) {
      if (!this.absentWarned.has(vaultPath)) {
        this.absentWarned.add(vaultPath)
        this.log.warn(`auto-commit stays off: vault ${vaultPath} does not exist`)
      }
      return null
    }
    const git = new MemoryGit(vaultPath, this.gitRunner(vaultPath))
    this.handles.set(vaultPath, git)
    try {
      await git.ensureRepo()
      return git
    } catch (error: unknown) {
      this.handles.delete(vaultPath)
      this.log.error(
        `git adoption failed for vault ${vaultPath}; the vault stays unmanaged: ${describeError(error)}`,
      )
      return null
    }
  }

  // LaneFor returns the vault's serialization lane, creating it on first use.
  private laneFor(vaultPath: string): SerialQueue {
    let lane = this.lanes.get(vaultPath)
    if (lane === undefined) {
      lane = createSerialQueue()
      this.lanes.set(vaultPath, lane)
    }
    return lane
  }
}
