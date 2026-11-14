import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'
import { PLUGIN_VAULT_DIR } from '../src/constants.ts'
import {
  INITIAL_COMMIT_MESSAGE,
  MEMORY_GITIGNORE_FILE,
  MEMORY_GITIGNORE_TEXT,
  MemoryGit,
  MemoryGitError,
  createGitRunner,
  type GitRunner,
} from '../src/memory-git.ts'

const RAW_PATH_ARGS = ['-c', 'core.quotepath=false']
const STATUS_ARGV = [...RAW_PATH_ARGS, 'status', '--porcelain', '--untracked-files=all']
const IDENTITY_PROBE_ARGV = ['config', 'user.email']
const IDENTITY_ARGS = [
  '-c',
  'user.name=obsidian-mem',
  '-c',
  'user.email=obsidian-mem@localhost',
]

/** LogArgv builds the argv MemoryGit must pass for one log read. */
function logArgv(count: number): string[] {
  return [
    ...RAW_PATH_ARGS,
    'log',
    `--max-count=${count}`,
    '--name-only',
    '--format=\x1e%H\x1f%cI\x1f%s',
  ]
}

/** A scripted git stand-in: each call pops the next reply and records argv. */
interface FakeReply {
  code?: number
  stdout?: string
  stderr?: string
}

function scriptedGit(replies: FakeReply[]): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const queue = [...replies]
  const run: GitRunner = async (argv) => {
    calls.push(argv)
    const reply = queue.shift() ?? {}
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { run, calls }
}

/** An identity the host git config already answers, so no fallback lands. */
const HOST_IDENTITY: FakeReply = { code: 0, stdout: 'dev@example.com\n' }

const tempDirs: string[] = []

/** TempDir makes a throwaway fixture root, removed after each test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-mem-core-git-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MemoryGit with a scripted runner', () => {
  it('names the in-root vault sidecar as the ignore-file pattern', () => {
    // The sidecar lives inside the vault root here, so the ignore text and
    // the core layout constant must name the same directory spelling.
    expect(MEMORY_GITIGNORE_TEXT).toContain(`${PLUGIN_VAULT_DIR}/\n`)
    expect(MEMORY_GITIGNORE_TEXT).not.toContain('.engramory-ext')
  })

  it('re-exports the git wrapper from the package root', () => {
    expect(core.MemoryGit).toBe(MemoryGit)
    expect(core.MEMORY_BRANCH).toBe('main')
    expect(core.DEFAULT_REMOTE).toBe('origin')
    expect(core.GIT_DIR_NAME).toBe('.git')
    expect(core.createGitRunner).toBe(createGitRunner)
  })

  it('reports isRepo from the exit code of rev-parse --git-dir', async () => {
    const inside = scriptedGit([{ code: 0 }])
    await expect(new MemoryGit('/memory', inside.run).isRepo()).resolves.toBe(true)
    expect(inside.calls).toEqual([['rev-parse', '--git-dir']])
    const outside = scriptedGit([{ code: 128 }])
    await expect(new MemoryGit('/memory', outside.run).isRepo()).resolves.toBe(false)
  })

  describe('ensureRepo', () => {
    it('adopts a fresh root: init, gitignore, and the initial commit', async () => {
      const dir = tempDir()
      const { run, calls } = scriptedGit([
        { code: 1 }, // rev-parse --git-dir: not a repo yet
        {}, // init -b main
        { code: 1 }, // rev-parse --verify --quiet HEAD: no commits yet
        { stdout: '?? .gitignore\n' }, // commitAll sees the new ignore file
        {}, // add -A
        HOST_IDENTITY, // config user.email probe
        {}, // commit -m (initial)
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      await expect(new MemoryGit(dir, run).ensureRepo()).resolves.toEqual({ initialized: true })
      expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(MEMORY_GITIGNORE_TEXT)
      expect(calls).toEqual([
        ['rev-parse', '--git-dir'],
        ['init', '-b', 'main'],
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        STATUS_ARGV,
        ['add', '-A'],
        IDENTITY_PROBE_ARGV,
        ['commit', '-m', INITIAL_COMMIT_MESSAGE],
        ['rev-parse', 'HEAD'],
      ])
    })

    it('is a no-op on a healthy repo and keeps an existing .gitignore', async () => {
      const dir = tempDir()
      writeFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'custom rules\n')
      const { run, calls } = scriptedGit([{ code: 0 }, { code: 0 }])
      await expect(new MemoryGit(dir, run).ensureRepo()).resolves.toEqual({ initialized: false })
      expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe('custom rules\n')
      expect(calls).toEqual([
        ['rev-parse', '--git-dir'],
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
      ])
    })

    it('defers the initial commit when the fresh store still holds nothing', async () => {
      const dir = tempDir()
      const { run, calls } = scriptedGit([
        { code: 1 }, // not a repo yet
        {}, // init -b main
        { code: 1 }, // no commits yet
        { stdout: '' }, // commitAll finds the tree clean
      ])
      await expect(new MemoryGit(dir, run).ensureRepo()).resolves.toEqual({ initialized: true })
      expect(calls).toEqual([
        ['rev-parse', '--git-dir'],
        ['init', '-b', 'main'],
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        STATUS_ARGV,
      ])
    })

    it('writes the constants plus anchored extra patterns when adopting with extras', async () => {
      const dir = tempDir()
      const { run } = scriptedGit([
        { code: 1 }, // not a repo yet
        {}, // init -b main
        { code: 1 }, // no commits yet
        { stdout: '?? .gitignore\n' },
        {}, // add -A
        HOST_IDENTITY,
        {}, // commit -m (initial)
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      const git = new MemoryGit(dir, run, { extraIgnorePaths: ['nested/sidecar', './dup/', 'dup'] })
      await expect(git.ensureRepo()).resolves.toEqual({ initialized: true })
      const text = readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')
      expect(text.startsWith(MEMORY_GITIGNORE_TEXT)).toBe(true)
      // Deduplicated and anchored at the root, and the file ends with a newline.
      expect(text.endsWith('/nested/sidecar/\n/dup/\n')).toBe(true)
    })

    it('appends only the still-missing extras to an existing file, once', async () => {
      const dir = tempDir()
      // No trailing newline: the append must add one before its own lines.
      writeFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'custom rules')
      const git = new MemoryGit(dir, scriptedGit([{ code: 0 }, { code: 0 }]).run, {
        extraIgnorePaths: ['sidecar'],
      })
      await git.ensureRepo()
      const appended = readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')
      const lines = appended.trimEnd().split('\n')
      expect(lines[0]).toBe('custom rules')
      expect(lines[lines.length - 1]).toBe('/sidecar/')
      // Idempotent: the pattern is present, so a second pass changes nothing.
      await new MemoryGit(dir, scriptedGit([{ code: 0 }, { code: 0 }]).run, {
        extraIgnorePaths: ['sidecar'],
      }).ensureRepo()
      expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(appended)
      // A late extra on a file that already ends with a newline appends
      // flush (header plus one line, no blank), and the constants still
      // never migrate into the user's file.
      await new MemoryGit(dir, scriptedGit([{ code: 0 }, { code: 0 }]).run, {
        extraIgnorePaths: ['sidecar', 'later'],
      }).ensureRepo()
      const withLater = readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')
      expect(withLater.startsWith(appended)).toBe(true)
      expect(withLater.endsWith('/later/\n')).toBe(true)
      expect(withLater).not.toContain('\n\n')
      expect(withLater.trimEnd().split('\n')).toHaveLength(lines.length + 2)
      // No extras configured: an existing file is never rewritten.
      await new MemoryGit(dir, scriptedGit([{ code: 0 }, { code: 0 }]).run).ensureRepo()
      expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(withLater)
    })
  })

  describe('commit identity fallback', () => {
    it('commits without overrides when the host config answers user.email', async () => {
      const { run, calls } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        HOST_IDENTITY, // config user.email probe
        {}, // commit -m
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      await expect(new MemoryGit('/memory', run).commitAll('note: edit')).resolves.toBe('feedfacecafe')
      expect(calls).toEqual([
        STATUS_ARGV,
        ['add', '-A'],
        IDENTITY_PROBE_ARGV,
        ['commit', '-m', 'note: edit'],
        ['rev-parse', 'HEAD'],
      ])
    })

    it('pins the plugin identity when the host config answers nothing', async () => {
      const { run, calls } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        { code: 1 }, // config user.email: unset keys exit 1 with no output
        {}, // commit -m
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      await expect(new MemoryGit('/memory', run).commitAll('note: edit')).resolves.toBe('feedfacecafe')
      expect(calls).toEqual([
        STATUS_ARGV,
        ['add', '-A'],
        IDENTITY_PROBE_ARGV,
        [...IDENTITY_ARGS, 'commit', '-m', 'note: edit'],
        ['rev-parse', 'HEAD'],
      ])
    })

    it('treats a configured-but-blank user.email as no identity', async () => {
      const { run, calls } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        { code: 0, stdout: '\n' }, // config user.email: the key exists, empty
        {}, // commit -m
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      await expect(new MemoryGit('/memory', run).commitAll('note: edit')).resolves.toBe('feedfacecafe')
      expect(calls[3]).toEqual([...IDENTITY_ARGS, 'commit', '-m', 'note: edit'])
    })

    it('probes once and reuses the cached answer across commits', async () => {
      const { run, calls } = scriptedGit([
        { stdout: ' M a.md\n' }, // first commitAll
        {}, // add -A
        { code: 1 }, // probe: no host identity
        {}, // commit
        { stdout: 'aaaa\n' }, // rev-parse HEAD
        { stdout: ' M b.md\n' }, // second commitAll: no probe rides along
        {}, // add -A
        {}, // commit
        { stdout: 'bbbb\n' }, // rev-parse HEAD
      ])
      const git = new MemoryGit('/memory', run)
      await expect(git.commitAll('note: one')).resolves.toBe('aaaa')
      await expect(git.commitAll('note: two')).resolves.toBe('bbbb')
      expect(calls.filter((argv) => argv[0] === 'config')).toEqual([IDENTITY_PROBE_ARGV])
      expect(calls[7]).toEqual([...IDENTITY_ARGS, 'commit', '-m', 'note: two'])
    })

    it('never probes or overrides when identityFallback is off', async () => {
      const { run, calls } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        {}, // commit -m
        { stdout: 'feedfacecafe\n' }, // rev-parse HEAD
      ])
      const git = new MemoryGit('/memory', run, { identityFallback: false })
      await expect(git.commitAll('note: edit')).resolves.toBe('feedfacecafe')
      expect(calls).toEqual([
        STATUS_ARGV,
        ['add', '-A'],
        ['commit', '-m', 'note: edit'],
        ['rev-parse', 'HEAD'],
      ])
    })
  })

  describe('status', () => {
    it('classifies porcelain lines into untracked, modified, and conflicted', async () => {
      const porcelain = [
        '?? new-note.md',
        ' M edited-note.md',
        'M  staged-note.md',
        'D  removed-note.md',
        'R  old-name.md -> renamed-note.md',
        'UU conflict-note.md',
        'AU staged-conflict.md',
        'AA both-added.md',
        'DD both-deleted.md',
      ].join('\n')
      const { run, calls } = scriptedGit([{ stdout: `${porcelain}\n` }])
      await expect(new MemoryGit('/memory', run).status()).resolves.toEqual({
        clean: false,
        untracked: ['new-note.md'],
        modified: ['edited-note.md', 'staged-note.md', 'removed-note.md', 'renamed-note.md'],
        conflicted: ['conflict-note.md', 'staged-conflict.md', 'both-added.md', 'both-deleted.md'],
      })
      expect(calls).toEqual([STATUS_ARGV])
    })

    it('reads an empty summary as a clean tree', async () => {
      const { run } = scriptedGit([{ stdout: '' }])
      await expect(new MemoryGit('/memory', run).status()).resolves.toEqual({
        clean: true,
        untracked: [],
        modified: [],
        conflicted: [],
      })
    })
  })

  describe('commitAll', () => {
    it('returns null without touching git past the status probe when the tree is clean', async () => {
      const { run, calls } = scriptedGit([{ stdout: '' }])
      await expect(new MemoryGit('/memory', run).commitAll('note: edit')).resolves.toBeNull()
      expect(calls).toEqual([STATUS_ARGV])
    })

    it('treats a lost commit race as a no-op', async () => {
      const { run } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        HOST_IDENTITY, // probe
        {
          code: 1,
          stdout: 'On branch main\nnothing to commit, working tree clean\n',
        },
      ])
      await expect(new MemoryGit('/memory', run).commitAll('note: edit')).resolves.toBeNull()
    })

    it('throws MemoryGitError when the commit itself fails', async () => {
      const { run } = scriptedGit([
        { stdout: ' M a-note.md\n' },
        {}, // add -A
        HOST_IDENTITY, // probe: no identity args ride on the failed argv
        { code: 128, stderr: 'fatal: unable to write commit object\n' },
      ])
      const failure = await new MemoryGit('/memory', run)
        .commitAll('note: edit')
        .catch((thrown: unknown) => thrown)
      expect(failure).toBeInstanceOf(MemoryGitError)
      const error = failure as MemoryGitError
      expect(error.code).toBe(128)
      expect(error.argv).toEqual(['commit', '-m', 'note: edit'])
      expect(error.stderr).toBe('fatal: unable to write commit object\n')
      expect(error.message).toBe(
        'git commit -m note: edit exited 128: fatal: unable to write commit object',
      )
    })
  })

  describe('log', () => {
    it('parses name-only records into per-commit paths', async () => {
      const output = [
        '',
        'aaaa1111\x1f2026-01-01T00:00:00+00:00\x1fInitial commit\n.gitignore\nMEMORY.md\n\n',
        'bbbb2222\x1f2026-01-02T00:00:00+00:00\x1fEmpty commit\n',
        'cccc3333\x1f2026-01-03T00:00:00+00:00\x1fLast commit',
      ].join('\x1e')
      const { run, calls } = scriptedGit([{ stdout: output }])
      await expect(new MemoryGit('/memory', run).log(3)).resolves.toEqual([
        {
          hash: 'aaaa1111',
          date: '2026-01-01T00:00:00+00:00',
          message: 'Initial commit',
          paths: ['.gitignore', 'MEMORY.md'],
        },
        {
          hash: 'bbbb2222',
          date: '2026-01-02T00:00:00+00:00',
          message: 'Empty commit',
          paths: [],
        },
        {
          hash: 'cccc3333',
          date: '2026-01-03T00:00:00+00:00',
          message: 'Last commit',
          paths: [],
        },
      ])
      expect(calls).toEqual([logArgv(3)])
    })

    it('reads a store with no commits yet as an empty history', async () => {
      const { run } = scriptedGit([
        { code: 128, stderr: "fatal: your current branch 'main' does not have any commits yet\n" },
      ])
      await expect(new MemoryGit('/memory', run).log(10)).resolves.toEqual([])
    })

    it('reads no output as an empty history', async () => {
      const { run } = scriptedGit([{ stdout: '' }])
      await expect(new MemoryGit('/memory', run).log(5)).resolves.toEqual([])
    })

    it('throws MemoryGitError on any other log failure', async () => {
      const { run } = scriptedGit([{ code: 128, stderr: 'fatal: bad object\n' }])
      await expect(new MemoryGit('/memory', run).log(5)).rejects.toBeInstanceOf(MemoryGitError)
    })
  })

  describe('remotes', () => {
    it('reports hasRemote from the exit code', async () => {
      const named = scriptedGit([{ code: 0 }])
      await expect(new MemoryGit('/memory', named.run).hasRemote()).resolves.toBe(true)
      expect(named.calls).toEqual([['remote', 'get-url', 'origin']])
      const missing = scriptedGit([{ code: 2, stderr: 'error: No such remote' }])
      await expect(new MemoryGit('/memory', missing.run).hasRemote('upstream')).resolves.toBe(false)
      expect(missing.calls).toEqual([['remote', 'get-url', 'upstream']])
    })
  })

  describe('sync commands', () => {
    it('fetches with defaults and an explicit remote', async () => {
      const defaults = scriptedGit([{}])
      await new MemoryGit('/memory', defaults.run).fetch()
      expect(defaults.calls).toEqual([['fetch', 'origin']])
      const named = scriptedGit([{}])
      await new MemoryGit('/memory', named.run).fetch('upstream')
      expect(named.calls).toEqual([['fetch', 'upstream']])
    })

    it('pulls fast-forward-only with defaults and explicit names', async () => {
      const defaults = scriptedGit([{}])
      await new MemoryGit('/memory', defaults.run).pull()
      expect(defaults.calls).toEqual([['pull', '--ff-only', 'origin', 'main']])
      const named = scriptedGit([{}])
      await new MemoryGit('/memory', named.run).pull('backup', 'trunk')
      expect(named.calls).toEqual([['pull', '--ff-only', 'backup', 'trunk']])
    })

    it('pushes with defaults and explicit names', async () => {
      const defaults = scriptedGit([{}])
      await new MemoryGit('/memory', defaults.run).push()
      expect(defaults.calls).toEqual([['push', 'origin', 'main']])
      const named = scriptedGit([{}])
      await new MemoryGit('/memory', named.run).push('backup', 'trunk')
      expect(named.calls).toEqual([['push', 'backup', 'trunk']])
    })

    it('throws MemoryGitError when a sync command fails', async () => {
      const { run } = scriptedGit([{ code: 128, stderr: 'fatal: could not read from remote\n' }])
      await expect(new MemoryGit('/memory', run).fetch()).rejects.toBeInstanceOf(MemoryGitError)
    })
  })

  describe('behindAhead', () => {
    it('parses the rev-list left-right count pair', async () => {
      const defaults = scriptedGit([{ stdout: '2\t5\n' }])
      await expect(new MemoryGit('/memory', defaults.run).behindAhead()).resolves.toEqual({
        behind: 2,
        ahead: 5,
      })
      expect(defaults.calls).toEqual([
        ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
      ])
      const named = scriptedGit([{ stdout: '0\t0\n' }])
      await expect(
        new MemoryGit('/memory', named.run).behindAhead('backup', 'trunk'),
      ).resolves.toEqual({ behind: 0, ahead: 0 })
      expect(named.calls).toEqual([
        ['rev-list', '--left-right', '--count', 'backup/trunk...HEAD'],
      ])
    })

    it('throws MemoryGitError when the remote ref is unknown', async () => {
      const { run } = scriptedGit([
        { code: 128, stderr: "fatal: ambiguous argument 'origin/main...HEAD'\n" },
      ])
      await expect(new MemoryGit('/memory', run).behindAhead()).rejects.toBeInstanceOf(
        MemoryGitError,
      )
    })
  })
})

describe('MemoryGit against real git', () => {
  const GIT_IDENTITY = [
    '-c',
    'user.name=Obsidian Mem Tests',
    '-c',
    'user.email=tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ]

  /** RealGit wraps a fixture dir with the default runner plus a test identity. */
  function realGit(dir: string): MemoryGit {
    const base = createGitRunner(dir)
    const run: GitRunner = (argv, opts) => base([...GIT_IDENTITY, ...argv], opts)
    return new MemoryGit(dir, run)
  }

  it('ensures a repo once and stays a no-op on re-runs', async () => {
    const dir = tempDir()
    await expect(new MemoryGit(dir).isRepo()).resolves.toBe(false)
    const git = realGit(dir)
    await expect(git.ensureRepo()).resolves.toEqual({ initialized: true })
    await expect(new MemoryGit(dir).isRepo()).resolves.toBe(true)
    expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(MEMORY_GITIGNORE_TEXT)
    await expect(git.status()).resolves.toMatchObject({ clean: true })
    const first = await git.log(10)
    expect(first).toHaveLength(1)
    expect(first[0]?.message).toBe(INITIAL_COMMIT_MESSAGE)
    expect(first[0]?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(first[0]?.paths).toEqual([MEMORY_GITIGNORE_FILE])

    await expect(git.ensureRepo()).resolves.toEqual({ initialized: false })
    await expect(git.log(10)).resolves.toHaveLength(1)
    expect(readFileSync(join(dir, MEMORY_GITIGNORE_FILE), 'utf8')).toBe(MEMORY_GITIGNORE_TEXT)
  })

  it('commits working-tree changes and answers clean afterwards', async () => {
    const dir = tempDir()
    const git = realGit(dir)
    await git.ensureRepo()
    writeFileSync(join(dir, 'note.md'), '# Note\n')
    await expect(git.status()).resolves.toMatchObject({ clean: false, untracked: ['note.md'] })
    await expect(git.commitAll('note: add one')).resolves.toMatch(/^[0-9a-f]{40}$/)
    await expect(git.status()).resolves.toMatchObject({ clean: true })
    await expect(git.commitAll('note: add again')).resolves.toBeNull()
    const history = await git.log(10)
    expect(history.map((entry) => entry.message)).toEqual(['note: add one', INITIAL_COMMIT_MESSAGE])
    expect(history[0]?.paths).toEqual(['note.md'])
  })

  it('keeps the .obsidian-mem vault sidecar out of every commit (real git)', async () => {
    const dir = tempDir()
    const git = realGit(dir)
    await expect(git.ensureRepo()).resolves.toEqual({ initialized: true })
    mkdirSync(join(dir, PLUGIN_VAULT_DIR, 'metadata'), { recursive: true })
    writeFileSync(join(dir, PLUGIN_VAULT_DIR, 'metadata', 'index-state.json'), '{}\n')
    writeFileSync(join(dir, 'note.md'), '# Note\n')
    // git itself refuses to see the sidecar: only the note is ever untracked.
    await expect(git.status()).resolves.toMatchObject({ untracked: ['note.md'] })
    await git.commitAll('note: add one')
    writeFileSync(join(dir, PLUGIN_VAULT_DIR, 'metadata', 'index-state.json'), '{"churn":1}\n')
    await expect(git.commitAll('must find nothing')).resolves.toBeNull()
  })

  it('reports an unknown remote ref as a behindAhead failure', async () => {
    const git = realGit(tempDir())
    await git.ensureRepo()
    await expect(git.behindAhead()).rejects.toBeInstanceOf(MemoryGitError)
  })

  describe('createGitRunner', () => {
    it('captures a successful git call', async () => {
      const runner = createGitRunner(tempDir())
      const result = await runner(['--version'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('git version')
    })

    it('resolves a non-zero exit as a result, not a rejection', async () => {
      const runner = createGitRunner(tempDir())
      const result = await runner(['status', '--porcelain'])
      expect(result.code).toBe(128)
      expect(result.stderr).toContain('not a git repository')
    })

    it('honors an explicit cwd over the bound one', async () => {
      const bound = tempDir()
      const other = tempDir()
      const runner = createGitRunner(bound)
      await runner(['init', '-b', 'main'])
      const otherRunner = createGitRunner(other)
      await otherRunner(['init', '-b', 'main'])
      const inside = await runner(['rev-parse', '--show-toplevel'])
      const overridden = await runner(['rev-parse', '--show-toplevel'], { cwd: other })
      // git reports the toplevel through the tmpdir symlink, so compare realpaths.
      expect(inside.stdout.trim()).toBe(realpathSync(bound))
      expect(overridden.stdout.trim()).toBe(realpathSync(other))
    })

    it('surfaces a git binary that never started', async () => {
      const runner = createGitRunner(tempDir(), 'obsidian-mem-no-such-git')
      await expect(runner(['--version'])).rejects.toThrow(/ENOENT/)
    })
  })
})
