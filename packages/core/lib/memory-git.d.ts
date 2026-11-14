/**
 * The git wrapper for the memory vaults. Every version-control move the
 * plugin makes (adopting a vault, auto-committing notes, reading churn,
 * syncing with a remote) goes through this one class, and it speaks git with
 * argv arrays only, never a shell string, so no path or message ever
 * interpolates into a command. The process boundary stays injectable:
 * `MemoryGit` takes a `GitRunner` whose default forks `git` through
 * `execFile`, so unit tests script git's replies with a fake and only the
 * integration specs fork the real binary (the pattern of
 * dsh-plugin-engramory-ext's memory-git module).
 * @module dsh-plugin-obsidian-mem/core/memory-git
 */
/** The branch every memory repo starts on (`git init -b`). */
export declare const MEMORY_BRANCH = "main";
/** The remote name the plugin syncs with unless the caller names another. */
export declare const DEFAULT_REMOTE = "origin";
/** The defensive ignore file ensureRepo keeps at the vault root. */
export declare const MEMORY_GITIGNORE_FILE = ".gitignore";
/**
 * Basename of the directory git keeps inside a repo. Nothing under it is a
 * memory edit: the service watcher filters events carrying this name, and
 * the audit's note listing never reads it as a note.
 */
export declare const GIT_DIR_NAME = ".git";
/**
 * MEMORY_GITIGNORE_TEXT is the content ensureRepo writes once at the vault
 * root. Unlike the reference plugin, this plugin keeps its vault sidecar
 * INSIDE the indexed root ({@link PLUGIN_VAULT_DIR}, holding the indexer
 * state and DREAMS.md), so the ignore pattern is load-bearing: it keeps
 * sidecar churn out of every `git add -A`.
 */
export declare const MEMORY_GITIGNORE_TEXT: string;
/** The message ensureRepo puts on a vault's very first commit. */
export declare const INITIAL_COMMIT_MESSAGE = "obsidian-mem: initial memory commit";
/** The outcome of one git call: the exit code plus the captured streams. */
export interface GitRunResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** The steering one git call accepts. */
export interface GitRunOptions {
    /** Directory the command runs in; defaults to the runner's bound cwd. */
    cwd?: string;
}
/** One git invocation: argv (without the program name) in, result out. */
export type GitRunner = (argv: string[], opts?: GitRunOptions) => Promise<GitRunResult>;
/**
 * MemoryGitOptions steers the defensive ignore file and the commit identity.
 * The service passes a configured data directory here when the config points
 * it inside the vault root, so a `git add -A` can never capture sidecar
 * churn; the core stays ignorant of config and sees only root-relative
 * paths.
 */
export interface MemoryGitOptions {
    /** Root-relative posix directory paths the ignore file must also cover. */
    readonly extraIgnorePaths?: readonly string[];
    /**
     * When true (the default) commits carry IDENTITY_FALLBACK_ARGS on a host
     * whose git config names no user.email; false never probes or overrides.
     */
    readonly identityFallback?: boolean;
}
/** MemoryGitError reports a git call that exited non-zero unexpectedly. */
export declare class MemoryGitError extends Error {
    /** The argv (without the program name) of the failed call. */
    readonly argv: string[];
    /** The process exit code. */
    readonly code: number;
    /** The command's captured stderr. */
    readonly stderr: string;
    constructor(
    /** The argv (without the program name) of the failed call. */
    argv: string[],
    /** The process exit code. */
    code: number,
    /** The command's captured stderr. */
    stderr: string);
}
/**
 * CreateGitRunner builds the default GitRunner: it forks the git binary
 * through execFile with argv arrays (never a shell string), bound to
 * defaultCwd unless a call overrides it. A non-zero exit resolves as a
 * result; only a git that never started (a missing binary) rejects.
 * @param defaultCwd - the directory commands run in unless opts.cwd says otherwise.
 * @param program - the git binary to fork; only tests pass a stand-in.
 */
export declare function createGitRunner(defaultCwd: string, program?: string): GitRunner;
/** The working tree's porcelain summary, split by kind. */
export interface MemoryGitStatus {
    /** True when there is nothing to record, commit, or resolve. */
    clean: boolean;
    /** Paths present in the tree but not yet tracked. */
    untracked: string[];
    /** Tracked paths with staged or unstaged changes, plus adds, deletes, renames. */
    modified: string[];
    /** Paths a merge left unmerged; sync must resolve these before pushing. */
    conflicted: string[];
}
/** One commit with the paths it touched, the churn-analysis input. */
export interface MemoryGitCommit {
    /** The full commit hash. */
    hash: string;
    /** The committer date in strict ISO 8601 form. */
    date: string;
    /** The commit's subject line. */
    message: string;
    /** The paths the commit changed. */
    paths: string[];
}
/** How far the checked-out branch sits from its remote counterpart. */
export interface MemoryGitSyncGap {
    /** Commits the local branch lacks (the remote has, the local does not). */
    behind: number;
    /** Commits the local branch holds beyond the remote counterpart. */
    ahead: number;
}
/**
 * MemoryGit versions one vault root: the same class the write-commit seam,
 * the churn audit, and the dream sync use, so git's raw text stops here and
 * every consumer receives plain data. It never adds or logs credentials; a
 * remote URL passes through to git verbatim.
 */
export declare class MemoryGit {
    /** The vault root every command runs in. */
    readonly root: string;
    /** The git boundary; defaults to forking the real binary at the root. */
    private readonly run;
    /** Ignore-file and identity steering. */
    readonly options: MemoryGitOptions;
    private identityConfigured?;
    constructor(
    /** The vault root every command runs in. */
    root: string,
    /** The git boundary; defaults to forking the real binary at the root. */
    run?: GitRunner,
    /** Ignore-file and identity steering. */
    options?: MemoryGitOptions);
    /** IsRepo reports whether the root already sits inside a git repository. */
    isRepo(): Promise<boolean>;
    /**
     * EnsureRepo converges the root onto the plugin's expected state: `init -b
     * main` when it is not yet a repo, the defensive `.gitignore`, and one
     * initial commit of whatever the vault already holds when the repo has no
     * commit yet. It is idempotent and cheap to re-run (two probe calls on a
     * healthy repo), so every writer may call it before committing.
     */
    ensureRepo(): Promise<{
        initialized: boolean;
    }>;
    /** Status summarizes the working tree from `status --porcelain`. */
    status(): Promise<MemoryGitStatus>;
    /**
     * CommitAll records every current change as one commit (`add -A` then
     * `commit -m`) and returns the new commit's full hash. It returns null when
     * the tree is already clean, and also null when a concurrent writer lands
     * the changes between the status probe and the commit (git answers "nothing
     * to commit"), so the per-write commit never races into a failure.
     * @param message - the commit message to record.
     */
    commitAll(message: string): Promise<string | null>;
    /**
     * Log returns the newest `count` commits with the paths each touched, newest
     * first: the churn input behind the audit. A store with no commits yet
     * reads as an empty list, not an error.
     * @param count - the maximum number of commits to read.
     */
    log(count: number): Promise<MemoryGitCommit[]>;
    /** HasRemote reports whether the named remote is configured. */
    hasRemote(name?: string): Promise<boolean>;
    /** Fetch updates the named remote's tracking refs. */
    fetch(name?: string): Promise<void>;
    /**
     * Pull fast-forwards the memory branch onto its remote counterpart.
     * `--ff-only` keeps the memory history linear; a divergent tree stops the
     * merge with conflicted paths that `status` surfaces for the sync flow.
     * @param name - the remote to pull from.
     * @param branch - the branch to publish and update.
     */
    pull(name?: string, branch?: string): Promise<void>;
    /** Push publishes the memory branch to the named remote. */
    push(name?: string, branch?: string): Promise<void>;
    /** BehindAhead counts how far the branch trails and leads its remote counterpart. */
    behindAhead(name?: string, branch?: string): Promise<MemoryGitSyncGap>;
    /** RunChecked forks one command and returns stdout, throwing on non-zero exit. */
    private runChecked;
    /**
     * CommitIdentityArgs returns the argv prefix a commit needs: none when the
     * host's git config already answers `git config user.email` (probed once
     * per instance) or when identityFallback is off, and the plugin-named `-c`
     * overrides otherwise.
     */
    private commitIdentityArgs;
    /**
     * SyncGitignore converges the root `.gitignore`: the constants (plus any
     * extra patterns) when the file is absent, and an append of the extra
     * patterns still missing when one exists. The constants land only on the
     * file's first write (an existing file may be the user's own); extras
     * converge on every ensureRepo because a data directory moved inside the
     * root after adoption must stay out of the next `git add -A`. The append
     * is additive and idempotent.
     */
    private syncGitignore;
}
//# sourceMappingURL=memory-git.d.ts.map
