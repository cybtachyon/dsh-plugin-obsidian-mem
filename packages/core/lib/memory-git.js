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
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PLUGIN_VAULT_DIR } from './constants.js';
const execFileAsync = promisify(execFile);
/** The branch every memory repo starts on (`git init -b`). */
export const MEMORY_BRANCH = 'main';
/** The remote name the plugin syncs with unless the caller names another. */
export const DEFAULT_REMOTE = 'origin';
/** The defensive ignore file ensureRepo keeps at the vault root. */
export const MEMORY_GITIGNORE_FILE = '.gitignore';
/**
 * Basename of the directory git keeps inside a repo. Nothing under it is a
 * memory edit: the service watcher filters events carrying this name, and
 * the audit's note listing never reads it as a note.
 */
export const GIT_DIR_NAME = '.git';
/**
 * MEMORY_GITIGNORE_TEXT is the content ensureRepo writes once at the vault
 * root. Unlike the reference plugin, this plugin keeps its vault sidecar
 * INSIDE the indexed root ({@link PLUGIN_VAULT_DIR}, holding the indexer
 * state and DREAMS.md), so the ignore pattern is load-bearing: it keeps
 * sidecar churn out of every `git add -A`.
 */
export const MEMORY_GITIGNORE_TEXT = [
    '# Written by dsh-plugin-obsidian-mem. The plugin keeps its per-vault',
    '# sidecar (indexer state, the DREAMS.md diary) inside this directory',
    '# under the vault root; the pattern keeps that machinery out of the',
    '# memory history.',
    `${PLUGIN_VAULT_DIR}/`,
    '',
].join('\n');
// The subject prefix every plugin-authored commit carries. It has one home
// here so `git log --grep` finds plugin commits by the prefix alone, and the
// two message shapes below are its only renderings.
const COMMIT_MESSAGE_PREFIX = 'obsidian-mem:';
/** The message ensureRepo puts on a vault's very first commit. */
export const INITIAL_COMMIT_MESSAGE = `${COMMIT_MESSAGE_PREFIX} initial memory commit`;
/**
 * DatedCommitMessage renders the auto-commit subject convention every
 * plugin-created commit follows: `<prefix> <subject> <ISO 8601>`. The
 * write-commit and dream-commit call sites supply only their subject, so
 * the timestamped shape has one home and cannot fork between them.
 * @param subject - what the commit records, e.g. `dream` or `memory_write topic.md`.
 * @param when - the commit instant; defaults to now.
 */
export function datedCommitMessage(subject, when = new Date()) {
    return `${COMMIT_MESSAGE_PREFIX} ${subject} ${when.toISOString()}`;
}
/** The header ensureRepo puts above any host-requested extra ignore lines. */
const EXTRA_IGNORE_HEADER = '# Ignored sidecar directories (a configured path inside the vault root):';
// execFile defaults to a 1 MB capture; a long-lived memory tree's name-only
// log comfortably passes it, and a truncated stream would parse as a shorter
// history, so the wrapper captures generously instead.
const MAX_CAPTURED_OUTPUT = 16 * 1024 * 1024;
// git octal-escapes non-ASCII paths in porcelain and name-only output unless
// quoting is off; memory notes carry human names, so every listing command
// runs with this prefix and the parsers see raw paths.
const RAW_PATH_ARGS = ['-c', 'core.quotepath=false'];
// A store adopted on a machine with no git identity configured would fail
// every commit; the fallback names the plugin so commits never die on the
// missing user.name/user.email, and the probe below skips the overrides
// whenever the host already answers the question itself.
const IDENTITY_FALLBACK_ARGS = [
    '-c',
    'user.name=obsidian-mem',
    '-c',
    'user.email=obsidian-mem@localhost',
];
const IDENTITY_PROBE_ARGV = ['config', 'user.email'];
// git log records are delimited with control characters a commit subject or
// path cannot reasonably contain: %x1e-style record separators plus %x1f-style
// field separators, so parsing never splits on message text.
const LOG_RECORD = '\x1e';
const LOG_FIELD = '\x1f';
const LOG_FORMAT = `${LOG_RECORD}%H${LOG_FIELD}%cI${LOG_FIELD}%s`;
// `status --porcelain` prints two status columns, one space, then the path; a
// rename names both sides and the path after the arrow is the live one.
const PORCELAIN_STATUS_WIDTH = 2;
const PORCELAIN_PATH_OFFSET = PORCELAIN_STATUS_WIDTH + 1;
const PORCELAIN_RENAME_ARROW = ' -> ';
// The two non-fatal git refusals the wrapper absorbs as ordinary outcomes:
// committing a tree a concurrent writer just committed, and logging a store
// that has no commits yet.
const NOTHING_TO_COMMIT = /nothing to commit/;
const NO_COMMITS_YET = /does not have any commits/;
/** MemoryGitError reports a git call that exited non-zero unexpectedly. */
export class MemoryGitError extends Error {
    argv;
    code;
    stderr;
    constructor(
    /** The argv (without the program name) of the failed call. */
    argv,
    /** The process exit code. */
    code,
    /** The command's captured stderr. */
    stderr) {
        super(`git ${argv.join(' ')} exited ${code}: ${stderr.trim()}`);
        this.argv = argv;
        this.code = code;
        this.stderr = stderr;
        this.name = 'MemoryGitError';
    }
}
/**
 * CreateGitRunner builds the default GitRunner: it forks the git binary
 * through execFile with argv arrays (never a shell string), bound to
 * defaultCwd unless a call overrides it. A non-zero exit resolves as a
 * result; only a git that never started (a missing binary) rejects.
 * @param defaultCwd - the directory commands run in unless opts.cwd says otherwise.
 * @param program - the git binary to fork; only tests pass a stand-in.
 */
export function createGitRunner(defaultCwd, program = 'git') {
    return async (argv, opts) => {
        try {
            const { stdout, stderr } = await execFileAsync(program, argv, {
                cwd: opts?.cwd ?? defaultCwd,
                encoding: 'utf8',
                maxBuffer: MAX_CAPTURED_OUTPUT,
            });
            return { code: 0, stdout, stderr };
        }
        catch (error) {
            const failed = error;
            // execFile attaches a numeric exit code only when the process actually
            // ran; a string code (ENOENT and friends) is not a git answer, so it
            // surfaces to the caller instead of masquerading as a failed command.
            if (typeof failed.code !== 'number')
                throw error;
            const ran = failed;
            return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr };
        }
    };
}
/**
 * MemoryGit versions one vault root: the same class the write-commit seam,
 * the churn audit, and the dream sync use, so git's raw text stops here and
 * every consumer receives plain data. It never adds or logs credentials; a
 * remote URL passes through to git verbatim.
 */
export class MemoryGit {
    root;
    run;
    options;
    // The identity probe answers for the instance's lifetime: one host either
    // has a git identity or it does not, and per-vault probes on every commit
    // would fork a process for an answer that cannot change mid-session.
    identityConfigured;
    constructor(
    /** The vault root every command runs in. */
    root,
    /** The git boundary; defaults to forking the real binary at the root. */
    run = createGitRunner(root),
    /** Ignore-file and identity steering. */
    options = {}) {
        this.root = root;
        this.run = run;
        this.options = options;
    }
    /** IsRepo reports whether the root already sits inside a git repository. */
    async isRepo() {
        const result = await this.run(['rev-parse', '--git-dir']);
        return result.code === 0;
    }
    /**
     * EnsureRepo converges the root onto the plugin's expected state: `init -b
     * main` when it is not yet a repo, the defensive `.gitignore`, and one
     * initial commit of whatever the vault already holds when the repo has no
     * commit yet. It is idempotent and cheap to re-run (two probe calls on a
     * healthy repo), so every writer may call it before committing.
     */
    async ensureRepo() {
        const initialized = !(await this.isRepo());
        if (initialized)
            await this.runChecked(['init', '-b', MEMORY_BRANCH]);
        this.syncGitignore();
        const head = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']);
        if (head.code !== 0)
            await this.commitAll(INITIAL_COMMIT_MESSAGE);
        return { initialized };
    }
    /** Status summarizes the working tree from `status --porcelain`. */
    async status() {
        const porcelain = await this.runChecked([
            ...RAW_PATH_ARGS,
            'status',
            '--porcelain',
            '--untracked-files=all',
        ]);
        return parseStatus(porcelain);
    }
    /**
     * CommitAll records every current change as one commit (`add -A` then
     * `commit -m`) and returns the new commit's full hash. It returns null when
     * the tree is already clean, and also null when a concurrent writer lands
     * the changes between the status probe and the commit (git answers "nothing
     * to commit"), so the per-write commit never races into a failure.
     * @param message - the commit message to record.
     */
    async commitAll(message) {
        if ((await this.status()).clean)
            return null;
        await this.runChecked(['add', '-A']);
        const argv = [...(await this.commitIdentityArgs()), 'commit', '-m', message];
        const commit = await this.run(argv);
        if (commit.code !== 0) {
            if (NOTHING_TO_COMMIT.test(commit.stdout))
                return null;
            throw new MemoryGitError(argv, commit.code, commit.stderr);
        }
        return (await this.runChecked(['rev-parse', 'HEAD'])).trim();
    }
    /**
     * Log returns the newest `count` commits with the paths each touched, newest
     * first: the churn input behind the audit. A store with no commits yet
     * reads as an empty list, not an error.
     * @param count - the maximum number of commits to read.
     */
    async log(count) {
        const argv = [
            ...RAW_PATH_ARGS,
            'log',
            `--max-count=${count}`,
            '--name-only',
            `--format=${LOG_FORMAT}`,
        ];
        const result = await this.run(argv);
        if (result.code !== 0) {
            if (NO_COMMITS_YET.test(result.stderr))
                return [];
            throw new MemoryGitError(argv, result.code, result.stderr);
        }
        return parseLog(result.stdout);
    }
    /** HasRemote reports whether the named remote is configured. */
    async hasRemote(name = DEFAULT_REMOTE) {
        const result = await this.run(['remote', 'get-url', name]);
        return result.code === 0;
    }
    /** Fetch updates the named remote's tracking refs. */
    async fetch(name = DEFAULT_REMOTE) {
        await this.runChecked(['fetch', name]);
    }
    /**
     * Pull fast-forwards the memory branch onto its remote counterpart.
     * `--ff-only` keeps the memory history linear; a divergent tree stops the
     * merge with conflicted paths that `status` surfaces for the sync flow.
     * @param name - the remote to pull from.
     * @param branch - the branch to publish and update.
     */
    async pull(name = DEFAULT_REMOTE, branch = MEMORY_BRANCH) {
        await this.runChecked(['pull', '--ff-only', name, branch]);
    }
    /** Push publishes the memory branch to the named remote. */
    async push(name = DEFAULT_REMOTE, branch = MEMORY_BRANCH) {
        await this.runChecked(['push', name, branch]);
    }
    /** BehindAhead counts how far the branch trails and leads its remote counterpart. */
    async behindAhead(name = DEFAULT_REMOTE, branch = MEMORY_BRANCH) {
        const summary = await this.runChecked([
            'rev-list',
            '--left-right',
            '--count',
            `${name}/${branch}...HEAD`,
        ]);
        // `--left-right --count A...HEAD` prints "<only-A>\t<only-HEAD>", which
        // reads as behind then ahead for a remote...HEAD pair.
        const [behind, ahead] = summary.trim().split(/\s+/);
        return { behind: Number(behind), ahead: Number(ahead) };
    }
    /** RunChecked forks one command and returns stdout, throwing on non-zero exit. */
    async runChecked(argv) {
        const result = await this.run(argv);
        if (result.code !== 0)
            throw new MemoryGitError(argv, result.code, result.stderr);
        return result.stdout;
    }
    /**
     * CommitIdentityArgs returns the argv prefix a commit needs: none when the
     * host's git config already answers `git config user.email` (probed once
     * per instance) or when identityFallback is off, and the plugin-named `-c`
     * overrides otherwise.
     */
    async commitIdentityArgs() {
        if (this.options.identityFallback === false)
            return [];
        this.identityConfigured ??= this.run(IDENTITY_PROBE_ARGV).then((probe) => probe.code === 0 && probe.stdout.trim() !== '');
        return (await this.identityConfigured) ? [] : IDENTITY_FALLBACK_ARGS;
    }
    /**
     * SyncGitignore converges the root `.gitignore`: the constants (plus any
     * extra patterns) when the file is absent, and an append of the extra
     * patterns still missing when one exists. The constants land only on the
     * file's first write (an existing file may be the user's own); extras
     * converge on every ensureRepo because a data directory moved inside the
     * root after adoption must stay out of the next `git add -A`. The append
     * is additive and idempotent.
     */
    syncGitignore() {
        const file = path.join(this.root, MEMORY_GITIGNORE_FILE);
        const extras = extraIgnoreLines(this.options.extraIgnorePaths);
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, memoryGitignoreText(extras));
            return;
        }
        if (extras.length === 0)
            return;
        const current = fs.readFileSync(file, 'utf8');
        const present = new Set(current.split('\n').map((line) => line.trim()));
        const missing = extras.filter((line) => !present.has(line));
        if (missing.length === 0)
            return;
        const prefix = current.endsWith('\n') ? current : `${current}\n`;
        fs.writeFileSync(file, `${prefix}${EXTRA_IGNORE_HEADER}\n${missing.join('\n')}\n`);
    }
}
/**
 * ExtraIgnoreLines renders the options' root-relative paths as gitignore
 * directory patterns anchored at the vault root, deduplicated. A pattern
 * keeps its leading slash so a name like `data` can only ever mean the
 * root's own `data/`, never a same-named directory deeper in the notes.
 */
function extraIgnoreLines(pointers) {
    const lines = (pointers ?? []).map((pointer) => `/${pointer.replace(/^\.[/\\]+/, '').replace(/[/\\]+$/, '')}/`);
    return [...new Set(lines)];
}
/** MemoryGitignoreText builds the fresh-file content: the constants plus any extras section. */
function memoryGitignoreText(extras) {
    if (extras.length === 0)
        return MEMORY_GITIGNORE_TEXT;
    return `${MEMORY_GITIGNORE_TEXT}${EXTRA_IGNORE_HEADER}\n${extras.join('\n')}\n`;
}
/** ParseStatus classifies `status --porcelain` lines into the summary. */
function parseStatus(porcelain) {
    const untracked = [];
    const modified = [];
    const conflicted = [];
    for (const line of porcelain.split('\n')) {
        if (line === '')
            continue;
        const marker = line.slice(0, PORCELAIN_STATUS_WIDTH);
        const changed = porcelainPath(line.slice(PORCELAIN_PATH_OFFSET));
        // git spells every unmerged pair with a U except both-added and
        // both-deleted, which need naming on their own.
        if (marker === '??')
            untracked.push(changed);
        else if (marker.includes('U') || marker === 'AA' || marker === 'DD')
            conflicted.push(changed);
        else
            modified.push(changed);
    }
    return {
        clean: untracked.length === 0 && modified.length === 0 && conflicted.length === 0,
        untracked,
        modified,
        conflicted,
    };
}
/** PorcelainPath lifts the path off a porcelain entry; renames name both sides, the new path last. */
function porcelainPath(entry) {
    const arrow = entry.lastIndexOf(PORCELAIN_RENAME_ARROW);
    return arrow === -1 ? entry : entry.slice(arrow + PORCELAIN_RENAME_ARROW.length);
}
/** ParseLog splits `log --name-only` output framed by LOG_RECORD/LOG_FIELD into commits. */
function parseLog(output) {
    const commits = [];
    for (const record of output.split(LOG_RECORD)) {
        // The format leads with the record separator, so the pre-history chunk
        // is empty; every real record carries its two field separators.
        if (record === '')
            continue;
        const hashEnd = record.indexOf(LOG_FIELD);
        const dateEnd = record.indexOf(LOG_FIELD, hashEnd + 1);
        const bodyStart = record.indexOf('\n', dateEnd);
        commits.push({
            hash: record.slice(0, hashEnd),
            date: record.slice(hashEnd + 1, dateEnd),
            message: record.slice(dateEnd + 1, bodyStart === -1 ? record.length : bodyStart),
            paths: (bodyStart === -1 ? '' : record.slice(bodyStart + 1))
                .split('\n')
                .filter((line) => line !== ''),
        });
    }
    return commits;
}
//# sourceMappingURL=memory-git.js.map
