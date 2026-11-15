import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  INITIAL_COMMIT_MESSAGE,
  MEMORY_GITIGNORE_FILE,
  MEMORY_GITIGNORE_TEXT,
  PLUGIN_VAULT_DIR,
  createGitRunner,
} from '../../core/lib/index.js'
import type { GitRunner } from '../../core/lib/index.js'
import { VaultGitManager } from '../src/vault-git.ts'

/**
 * VaultGitManager tests for TASK-004, scripted through a fake GitRunner so
 * no unit case forks git: the enabled gate touches nothing; read-only
 * paths never pass the manager's shared guard; an absent root only logs the
 * "auto-commit stays off" warn and is never init'ed; a failed adoption
 * logs and leaves the vault unmanaged but retryable; commits are
 * serialized per vault in call order; commitAllShared covers exactly the
 * shared registry and skips clean trees; the read accessors answer null
 * for anything unmanaged. One final describe runs the real git binary over
 * a temp fixture (the plan's single integration case).
 */

// ---------------------------------------------------------------------------
// Fake repo: a per-root git state machine behind the GitRunner seam.

interface FakeRepoOptions {
  /** Answer the adoption probes as "not a repo yet" and fail `git init`. */
  adoptionFails?: boolean
}

interface FakeRepo {
  runFor: (root: string) => GitRunner
  calls: Array<{ root: string; argv: string[] }>
  commitMessages: (root: string) => string[]
  dirty: (root: string) => void
  clean: (root: string) => void
}

const OK = { code: 0, stdout: '', stderr: '' }

/**
 * FakeRepo scripts the argv shapes MemoryGit actually sends (status first,
 * `add -A`, the identity probe, `commit -m`, `rev-parse HEAD`). `dirty`
 * stays an explicit test control (commit does not clear it) so queued
 * commits can be steered without racing the fake.
 */
function fakeRepo(options: FakeRepoOptions = {}): FakeRepo {
  interface RepoState {
    initialized: boolean
    hasHead: boolean
    dirtyTree: boolean
    commits: string[]
  }
  const states = new Map<string, RepoState>()
  const calls: Array<{ root: string; argv: string[] }> = []
  const stateOf = (root: string): RepoState => {
    let state = states.get(root)
    if (state === undefined) {
      state = { initialized: false, hasHead: false, dirtyTree: true, commits: [] }
      states.set(root, state)
    }
    return state
  }
  const runFor = (root: string): GitRunner => async (argv) => {
    calls.push({ root, argv })
    await Promise.resolve()
    const state = stateOf(root)
    // MemoryGit prefixes listing commands with `-c core.quotepath=false`,
    // so dispatch on the real command word, not argv[0].
    const command = argv[0] === '-c' ? (argv[2] as string) : argv[0]!
    if (command === 'rev-parse' && argv.includes('--git-dir')) {
      return options.adoptionFails === true
        ? { code: 128, stdout: '', stderr: 'fatal: not a git repository (fake)' }
        : (state.initialized ? OK : { code: 128, stdout: '', stderr: 'fake: not a repo' })
    }
    if (command === 'init') {
      if (options.adoptionFails === true) {
        return { code: 128, stdout: '', stderr: 'fatal: fake init failure' }
      }
      state.initialized = true
      return OK
    }
    if (command === 'rev-parse' && argv.includes('HEAD') && argv.includes('--quiet')) {
      return state.hasHead ? OK : { code: 1, stdout: '', stderr: '' }
    }
    if (command === 'config') {
      return { code: 0, stdout: 'dev@example.com\n', stderr: '' }
    }
    if (command === 'status') {
      return { code: 0, stdout: state.dirtyTree ? '?? note.md\n' : '', stderr: '' }
    }
    if (command === 'add') return OK
    if (command === 'commit') {
      if (!state.dirtyTree) {
        return { code: 1, stdout: 'nothing to commit, working tree clean', stderr: '' }
      }
      state.hasHead = true
      state.commits.push(argv[argv.indexOf('-m') + 1]!)
      return OK
    }
    if (command === 'rev-parse') {
      return { code: 0, stdout: `hash-${String(state.commits.length).padStart(4, '0')}\n`, stderr: '' }
    }
    if (command === 'log') {
      const maxCount = Number(argv.find((a) => a.startsWith('--max-count='))?.slice(12) ?? 10)
      const records = [...state.commits]
        .reverse()
        .slice(0, maxCount)
        .map((message, index) => {
          const n = state.commits.length - index
          return `\x1ehash-${String(n).padStart(4, '0')}\x1f2026-11-14T00:00:00+00:00\x1f${message}\nnote.md\n`
        })
        .join('')
      return { code: 0, stdout: records, stderr: '' }
    }
    return OK
  }
  return {
    runFor,
    calls,
    commitMessages: (root) => states.get(root)?.commits ?? [],
    dirty: (root) => { stateOf(root).dirtyTree = true },
    clean: (root) => { stateOf(root).dirtyTree = false },
  }
}

// ---------------------------------------------------------------------------
// Harness.

const tempDirs: string[] = []

/** TempDir makes a throwaway fixture root (git's .gitignore write is real), removed after each test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-mem-svc-vault-git-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface HarnessOptions {
  enabled?: boolean
  shared?: string[]
  repo?: FakeRepoOptions
}

function harness(options: HarnessOptions = {}) {
  const repo = fakeRepo(options.repo ?? {})
  const warnings: string[] = []
  const errors: string[] = []
  const shared = options.shared ?? []
  const manager = new VaultGitManager({
    gitEnabled: () => options.enabled ?? true,
    sharedVaults: () => shared,
    exists: (path) => existsSync(path),
    gitRunner: repo.runFor,
    log: {
      warn: (message) => { warnings.push(message) },
      error: (message) => { errors.push(message) },
    },
  })
  return { manager, repo, warnings, errors, shared }
}

/** CommandName reduces one recorded argv to the git command it invokes. */
function cmdOf(argv: readonly string[]): string {
  return argv[0] === '-c' ? (argv[2] as string) : argv[0]!
}

/** RootCalls lists the recorded commands for one vault root. */
function rootCalls(repo: FakeRepo, root: string): string[] {
  return repo.calls.filter((call) => call.root === root).map((call) => cmdOf(call.argv))
}

// ---------------------------------------------------------------------------

describe('VaultGitManager with a fake git runner', () => {
  it('touches nothing when git is disabled', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'note.md'), '# Note\n')
    const h = harness({ enabled: false, shared: [dir] })

    await h.manager.ensureSharedVaults()
    await h.manager.ensureVault(dir)
    await expect(h.manager.commitVault(dir, 'msg')).resolves.toBeNull()
    await expect(h.manager.commitAllShared('msg')).resolves.toEqual([])
    await expect(h.manager.statusShared(dir)).resolves.toBeNull()
    await expect(h.manager.logShared(dir, 5)).resolves.toBeNull()
    expect(h.manager.adoptedRoots()).toEqual([])

    expect(h.repo.calls).toEqual([])
    expect(existsSync(join(dir, MEMORY_GITIGNORE_FILE))).toBe(false)
    expect(h.warnings).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('never manages a read-only (non-shared) vault path', async () => {
    const sharedDir = tempDir()
    const readOnlyDir = tempDir()
    const h = harness({ shared: [sharedDir] })

    await h.manager.ensureSharedVaults()
    await h.manager.ensureVault(readOnlyDir)
    await expect(h.manager.commitVault(readOnlyDir, 'msg')).resolves.toBeNull()
    await expect(h.manager.statusShared(readOnlyDir)).resolves.toBeNull()
    await expect(h.manager.logShared(readOnlyDir, 5)).resolves.toBeNull()

    expect(h.repo.calls.every((call) => call.root === sharedDir)).toBe(true)
  })

  it('logs an absent shared root once and never git-inits it', async () => {
    const missing = join(tempDir(), 'not-created')
    const h = harness({ shared: [missing] })

    await h.manager.ensureSharedVaults()
    await h.manager.ensureSharedVaults()
    await expect(h.manager.commitVault(missing, 'msg')).resolves.toBeNull()

    expect(h.warnings).toEqual([`auto-commit stays off: vault ${missing} does not exist`])
    expect(h.repo.calls).toEqual([])
    expect(h.manager.adoptedRoots()).toEqual([])
  })

  it('adopts a fresh shared root: init -b main, the ignore file, one initial commit', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'note.md'), '# Note\n')
    const h = harness({ shared: [dir] })

    await h.manager.ensureSharedVaults()

    expect(rootCalls(h.repo, dir)).toEqual([
      'rev-parse', 'init', 'rev-parse', 'status', 'add', 'config', 'commit', 'rev-parse',
      'ls-files',
    ])
    expect(h.repo.calls.find((call) => cmdOf(call.argv) === 'init')?.argv)
      .toEqual(['init', '-b', 'main'])
    expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(MEMORY_GITIGNORE_TEXT)
    expect(h.repo.commitMessages(dir)).toEqual([INITIAL_COMMIT_MESSAGE])
    expect(h.manager.adoptedRoots()).toEqual([dir])
    expect(h.errors).toEqual([])

    // Re-runs are even cheaper than git probes: the managed handle is held
    // in memory, so a healthy vault produces no git calls at all.
    h.repo.calls.length = 0
    await h.manager.ensureSharedVaults()
    expect(h.repo.calls).toEqual([])
  })

  it('commitVault adopts lazily, answers the new hash, and nulls a clean tree', async () => {
    const dir = tempDir()
    const h = harness({ shared: [dir] })

    // No adoption pass ran first: the commit call adopts through the same
    // ensureRepo seam inside its lane, which is how a disabled-to-enabled
    // flip lets the next write commit.
    const hash = await h.manager.commitVault(dir, 'obsidian-mem: memory_write topic.md 2026-11-14T08:00:00.000Z')
    expect(hash).toBe('hash-0002')
    expect(h.manager.adoptedRoots()).toEqual([dir])
    expect(h.repo.commitMessages(dir)).toEqual([
      INITIAL_COMMIT_MESSAGE,
      'obsidian-mem: memory_write topic.md 2026-11-14T08:00:00.000Z',
    ])

    h.repo.clean(dir)
    h.repo.calls.length = 0
    await expect(h.manager.commitVault(dir, 'must find nothing')).resolves.toBeNull()
    expect(rootCalls(h.repo, dir)).toEqual(['status'])
    expect(h.repo.commitMessages(dir)).toHaveLength(2)
  })

  it('serializes per-vault commits in call order', async () => {
    const dir = tempDir()
    const h = harness({ shared: [dir] })
    await h.manager.ensureSharedVaults()

    const first = h.manager.commitVault(dir, 'msg one')
    const second = h.manager.commitVault(dir, 'msg two')
    await expect(first).resolves.toBe('hash-0002')
    await expect(second).resolves.toBe('hash-0003')

    expect(h.repo.commitMessages(dir)).toEqual([INITIAL_COMMIT_MESSAGE, 'msg one', 'msg two'])
    // The second add+commit pair starts only after the first rev-parse: no
    // two status→commit pairs ever interleave inside one vault's history.
    // (slice(9) skips the nine-call adoption wave, the ls-files probe last.)
    const after = rootCalls(h.repo, dir).slice(9)
    expect(after).toEqual([
      'status', 'add', 'commit', 'rev-parse',
      'status', 'add', 'commit', 'rev-parse',
    ])
  })

  it('commitAllShared covers exactly the shared vaults and skips clean trees', async () => {
    const dirtyDir = tempDir()
    const cleanDir = tempDir()
    const h = harness({ shared: [dirtyDir, cleanDir] })
    await h.manager.ensureSharedVaults()
    h.repo.clean(cleanDir)

    h.repo.calls.length = 0
    const outcomes = await h.manager.commitAllShared('obsidian-mem: dream 2026-11-14T08:00:00.000Z')

    expect(outcomes).toEqual([
      { vault: dirtyDir, hash: 'hash-0002' },
      { vault: cleanDir, hash: null },
    ])
    expect(h.repo.commitMessages(cleanDir)).toEqual([INITIAL_COMMIT_MESSAGE])
    // Post-adoption, the clean vault was probed (status) but never staged.
    expect(rootCalls(h.repo, cleanDir)).toEqual(['status'])
  })

  it('logShared and statusShared answer managed vaults newest-first, and null otherwise', async () => {
    const dir = tempDir()
    const unmanaged = tempDir()
    const h = harness({ shared: [dir] })

    await expect(h.manager.logShared(dir, 10)).resolves.toBeNull()
    await expect(h.manager.statusShared(dir)).resolves.toBeNull()

    await h.manager.ensureSharedVaults()
    const initial = await h.manager.logShared(dir, 10)
    expect(initial).toEqual([{
      hash: 'hash-0001',
      date: '2026-11-14T00:00:00+00:00',
      message: INITIAL_COMMIT_MESSAGE,
      paths: ['note.md'],
    }])

    h.repo.dirty(dir)
    await h.manager.commitVault(dir, 'note two')
    h.repo.clean(dir)
    const history = await h.manager.logShared(dir, 10)
    expect(history?.map((entry) => entry.message)).toEqual(['note two', INITIAL_COMMIT_MESSAGE])
    expect(await h.manager.statusShared(dir)).toEqual({
      clean: true, untracked: [], modified: [], conflicted: [],
    })

    // A registered-but-never-adopted path answers null without forking git.
    h.shared.push(unmanaged)
    await expect(h.manager.statusShared(unmanaged)).resolves.toBeNull()
    expect(h.repo.calls.some((call) => call.root === unmanaged)).toBe(false)
  })

  it('a failed adoption logs, leaves the vault unmanaged, and retries on the next call', async () => {
    const dir = tempDir()
    const h = harness({ shared: [dir], repo: { adoptionFails: true } })

    await h.manager.ensureSharedVaults()
    expect(h.errors.join('\n')).toContain(`git adoption failed for vault ${dir}`)
    expect(h.manager.adoptedRoots()).toEqual([])
    await expect(h.manager.statusShared(dir)).resolves.toBeNull()

    // The next commit retries through the same ensureRepo seam, still no throw.
    await expect(h.manager.commitVault(dir, 'later')).resolves.toBeNull()
    expect(h.repo.calls.filter((call) => cmdOf(call.argv) === 'init')).toHaveLength(2)
  })

  it('forget drops the handle and lane of a removed vault', async () => {
    const dir = tempDir()
    const h = harness({ shared: [dir] })
    await h.manager.ensureSharedVaults()
    expect(h.manager.adoptedRoots()).toEqual([dir])

    h.manager.forget(dir)
    expect(h.manager.adoptedRoots()).toEqual([])
    await expect(h.manager.statusShared(dir)).resolves.toBeNull()

    h.shared.length = 0
    expect(h.manager.adoptedRoots()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The plan's single real-git integration case (fake-free, temp fixture).

describe('VaultGitManager against real git', () => {
  const GIT_IDENTITY = [
    '-c',
    'user.name=Obsidian Mem Tests',
    '-c',
    'user.email=tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ]

  it('adopts a fixture vault, keeps the sidecar untracked, and commits the next write', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'note.md'), '# Note one\n')
    mkdirSync(join(dir, PLUGIN_VAULT_DIR, 'metadata'), { recursive: true })
    writeFileSync(join(dir, PLUGIN_VAULT_DIR, 'metadata', 'index-state.json'), '{}\n')

    const warnings: string[] = []
    const errors: string[] = []
    const manager = new VaultGitManager({
      gitEnabled: () => true,
      sharedVaults: () => [dir],
      exists: (path) => existsSync(path),
      gitRunner: (root) => {
        const base = createGitRunner(root)
        return (argv, opts) => base([...GIT_IDENTITY, ...argv], opts)
      },
      log: {
        warn: (message) => { warnings.push(message) },
        error: (message) => { errors.push(message) },
      },
    })

    await manager.ensureSharedVaults()
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toContain(`${PLUGIN_VAULT_DIR}/\n`)

    // ensureRepo adopted: the note and the ignore file are committed, and
    // the sidecar never reaches the working-tree summary.
    const afterAdoption = await manager.statusShared(dir)
    expect(afterAdoption).toMatchObject({ clean: true })

    writeFileSync(join(dir, 'note-two.md'), '# Note two\n')
    const hash = await manager.commitVault(dir, 'obsidian-mem: memory_write note-two.md 2026-11-14T08:00:00.000Z')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)

    const history = await manager.logShared(dir, 10)
    expect(history?.map((entry) => entry.message)).toEqual([
      'obsidian-mem: memory_write note-two.md 2026-11-14T08:00:00.000Z',
      INITIAL_COMMIT_MESSAGE,
    ])
    expect(history?.[0]?.paths).toEqual(['note-two.md'])

    // Sidecar churn alone is git-invisible: the pass finds nothing to record.
    writeFileSync(join(dir, PLUGIN_VAULT_DIR, 'metadata', 'index-state.json'), '{"churn":1}\n')
    await expect(manager.commitVault(dir, 'must find nothing')).resolves.toBeNull()

    // Re-adoption stays idempotent against the real repo.
    await manager.ensureSharedVaults()
    await expect(manager.logShared(dir, 10)).resolves.toHaveLength(2)
  })
})
