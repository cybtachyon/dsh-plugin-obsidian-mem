import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MILVUS_LITE_VERSION,
  MilvusDataDirLockedError,
  MilvusForeignServerError,
  MilvusLauncher,
  PORT_FILE_NAME,
  type LiteSpawnOptions,
  type MilvusLauncherOptions,
} from '../src/milvus/launcher.ts'
import type { MilvusProbe } from '../src/milvus/client.ts'

/**
 * Unit tests for the Milvus-Lite launcher: every external process goes
 * through the injected LiteSpawner stub and every gRPC touch point through
 * an injected probe stub, so this tier never spawns uvx or binds a server.
 * The verified spawn argv, port-file lifecycle, attach/foreign/lock paths,
 * degraded respawn, and teardown are all asserted here; the live uvx tier
 * lives in milvus-live.spec.ts (RUN_LIVE=1 only).
 */

/** FakeChild is a LiteChild test double: signals, stderr, and exit are manual. */
class FakeChild {
  readonly pid: number | undefined
  readonly killSignals: string[] = []
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private readonly stderrListeners: Array<(chunk: string | Buffer) => void> = []
  readonly stderr = {
    on: (event: string, listener: (chunk: string | Buffer) => void): unknown => {
      if (event === 'data') {
        this.stderrListeners.push(listener)
      }
      return this
    },
  }

  constructor(pid: number) {
    this.pid = pid
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal ?? 'SIGTERM'))
    return true
  }

  once(event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown {
    if (event === 'exit') {
      this.exitListeners.push(listener)
    }
    return this
  }

  emitStderr(text: string): void {
    for (const listener of this.stderrListeners) {
      listener(text)
    }
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.exitListeners]) {
      listener(code, signal)
    }
  }
}

interface SpawnCall {
  command: string
  args: readonly string[]
  options: LiteSpawnOptions
  child: FakeChild
}

/** Recording spawner stub; onSpawn hooks let tests react to each spawn. */
function recordingSpawner(onSpawn?: (call: SpawnCall) => void) {
  const calls: SpawnCall[] = []
  let nextPid = 41_000
  const spawner = (command: string, args: readonly string[], options: LiteSpawnOptions) => {
    const child = new FakeChild(nextPid)
    nextPid += 1
    const call = { command, args, options, child }
    calls.push(call)
    onSpawn?.(call)
    return child
  }
  return { calls, spawner }
}

/**
 * FakeProbe answers health/version while isAlive() is true; everything else
 * rejects like an unconnected gRPC channel.
 */
class FakeProbe implements MilvusProbe {
  readonly connectPromise = Promise.resolve()
  private healthCalls = 0

  constructor(
    private readonly behavior: {
      isAlive: () => boolean
      version: string
      healthyAfter?: number
    },
  ) {}

  async checkHealth(): Promise<{ isHealthy: boolean }> {
    if (!this.behavior.isAlive()) {
      throw new Error('14 UNAVAILABLE: No connection established')
    }
    this.healthCalls += 1
    const healthyAfter = this.behavior.healthyAfter ?? 0
    return { isHealthy: this.healthCalls > healthyAfter }
  }

  async getVersion(): Promise<{ version: string }> {
    if (!this.behavior.isAlive()) {
      throw new Error('14 UNAVAILABLE: No connection established')
    }
    return { version: this.behavior.version }
  }

  close(): void {}
}

const LITE_VERSION = `milvus_lite-${MILVUS_LITE_VERSION}`

function portOf(address: string): string {
  const port = address.split(':').at(-1)
  if (!port) {
    throw new Error(`no port in ${address}`)
  }
  return port
}

const cleanups: Array<() => void> = []

/** makeLauncher builds a launcher with fast timers and stub seams. */
function makeLauncher(
  options: MilvusLauncherOptions & { dataDir: string },
): MilvusLauncher {
  const launcher = new MilvusLauncher({
    readinessTimeoutMs: 1_000,
    readinessIntervalMs: 1,
    killGraceMs: 20,
    respawnBaseDelayMs: 1,
    respawnMaxDelayMs: 10,
    env: { PATH: '' },
    log: () => undefined,
    ...options,
  })
  cleanups.push(() => {
    void launcher.dispose().catch(() => undefined)
  })
  return launcher
}

function tempDataDir(prefix = 'memlite-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
})

describe('MilvusLauncher spawn mode', () => {
  it('spawns the pinned verified command once and records {port,pid}', async () => {
    const dataDir = tempDataDir()
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
    })

    const [first, second] = await Promise.all([launcher.start(), launcher.start()])

    expect(first).toEqual(second)
    expect(first.spawned).toBe(true)
    expect(first.version).toBe(LITE_VERSION)
    // One flight, one child.
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe('/fake/uvx')
    expect(call.args).toEqual([
      '--with',
      'pymilvus',
      '--from',
      `milvus-lite==${MILVUS_LITE_VERSION}`,
      'milvus-lite',
      'server',
      '--data-dir',
      dataDir,
      '--host',
      '127.0.0.1',
      '--port',
      portOf(first.address),
    ])
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(call.options.detached).toBe(false)
    expect(launcher.address).toBe(first.address)

    const record = JSON.parse(readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')) as {
      port: number
      pid: number | null
    }
    expect(record.port).toBe(Number(portOf(first.address)))
    expect(record.pid).toBe(call.child.pid)
  })

  it('attaches without spawning when a milvus-lite answers on the recorded port', async () => {
    const dataDir = tempDataDir()
    const recordedAddress = '127.0.0.1:54321'
    writeFileSync(
      join(dataDir, PORT_FILE_NAME),
      `${JSON.stringify({ port: 54_321, pid: 999 })}\n`,
    )
    const { calls, spawner } = recordingSpawner()
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: (address) =>
        new FakeProbe({
          isAlive: () => address === recordedAddress,
          version: LITE_VERSION,
        }),
    })

    const result = await launcher.start()

    expect(result).toEqual({ address: recordedAddress, version: LITE_VERSION, spawned: false })
    expect(calls).toHaveLength(0)
    // The owner's port file must survive an attach.
    expect(readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')).toContain('54321')
  })

  it('refuses a foreign full-Milvus answering where spawn mode expected lite', async () => {
    const dataDir = tempDataDir()
    writeFileSync(join(dataDir, PORT_FILE_NAME), JSON.stringify({ port: 19_530, pid: 7 }))
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner: recordingSpawner().spawner,
      probeFactory: () =>
        new FakeProbe({ isAlive: () => true, version: 'v3.0.0-full-standalone' }),
    })

    await expect(launcher.start()).rejects.toThrow(MilvusForeignServerError)
  })

  it('retries health, then fails with the offline-cold-start hint on timeout', async () => {
    const dataDir = tempDataDir()
    const { calls, spawner } = recordingSpawner()
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => false, version: LITE_VERSION }),
      readinessTimeoutMs: 60,
    })

    await expect(launcher.start()).rejects.toThrow(/no healthy milvus-lite[\s\S]*cold uvx/)
    // The failed startup must not leave a child or a stale port file.
    expect(calls[0]!.child.killSignals).toContain('SIGTERM')
    expect(() => readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')).toThrow()
  })

  it('classifies a DataDirLockedError exit and attaches to the owner', async () => {
    const dataDir = tempDataDir()
    const ownerAddress = '127.0.0.1:54321'
    writeFileSync(join(dataDir, PORT_FILE_NAME), JSON.stringify({ port: 54_321, pid: 777 }))
    let ownerUp = false
    const { calls, spawner } = recordingSpawner()
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: (address) =>
        new FakeProbe({
          isAlive: () => ownerUp && address === ownerAddress,
          version: LITE_VERSION,
        }),
      readinessTimeoutMs: 2_000,
    })

    const starting = launcher.start()
    await vi.waitFor(() => expect(calls.length).toBe(1))
    const child = calls[0]!.child
    ownerUp = true // the real owner finished booting and grabs the lock
    child.emitStderr(`milvus_lite.exceptions.${'DataDirLockedError'}: another process holds the lock on '${dataDir}'`)
    child.emitExit(1, null)

    const result = await starting

    expect(result).toEqual({ address: ownerAddress, version: LITE_VERSION, spawned: false })
    // The owner's original {port,pid} record was restored over ours.
    const record = JSON.parse(readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')) as {
      port: number
      pid: number | null
    }
    expect(record).toEqual({ port: 54_321, pid: 777 })
  })

  it('fails with an actionable lock message when the owner is unreachable', async () => {
    const dataDir = tempDataDir()
    const { calls, spawner } = recordingSpawner()
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => false, version: LITE_VERSION }),
      readinessTimeoutMs: 2_000,
    })

    const starting = launcher.start()
    await vi.waitFor(() => expect(calls.length).toBe(1))
    calls[0]!.child.emitStderr(`milvus_lite.exceptions.${'DataDirLockedError'}: locked`)
    calls[0]!.child.emitExit(1, null)

    await expect(starting).rejects.toThrow(MilvusDataDirLockedError)
    await expect(starting).rejects.toThrow(/Stop the other plugin instance/)
  })

  it('moves a legacy 2.x single-file database aside and logs loudly', async () => {
    const parent = tempDataDir()
    const dataDir = join(parent, 'memory.db')
    writeFileSync(dataDir, 'legacy 2.x single-file db')
    const logs: string[] = []
    let alive = false
    const { spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
      log: (message) => logs.push(message),
    })

    await launcher.start()

    expect(() => readFileSync(dataDir, 'utf8')).toThrow() // original path is gone
    const moved = readdirNames(parent).find((name) => name.startsWith('memory.db.legacy-2x-'))
    expect(moved).toBeDefined()
    expect(logs.some((line) => line.includes('legacy 2.x') && line.includes('no migration'))).toBe(
      true,
    )
  })

  it('marks degraded on unexpected child exit and respawns with backoff', async () => {
    const dataDir = tempDataDir()
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
    })

    const first = await launcher.start()
    expect(calls).toHaveLength(1)

    // Crash: server down, child gone.
    alive = false
    calls[0]!.child.emitExit(null, 'SIGKILL')
    expect(launcher.degraded).toBe(true)

    await vi.waitFor(() => expect(calls.length).toBe(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(launcher.degraded).toBe(false), { timeout: 2_000 })
    expect(launcher.address).toBe(first.address) // recorded port reused
    expect(calls[1]!.args).toContain(portOf(first.address))
  })

  it('keeps respawning with backoff when the respawn itself fails', async () => {
    const dataDir = tempDataDir()
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      // first spawn lives; respawn spawns never come up and exit
      if (calls.length > 1) {
        const dead = calls.at(-1)!.child
        setImmediate(() => dead.emitExit(1, null))
      } else {
        alive = true
      }
    })
    const logs: string[] = []
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
      readinessTimeoutMs: 30,
      log: (message) => logs.push(message),
    })

    await launcher.start()
    alive = false
    calls[0]!.child.emitExit(1, null)
    expect(launcher.degraded).toBe(true)

    // Two failed respawns at least: the loop backs off instead of spinning.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3), { timeout: 4_000 })
    expect(launcher.degraded).toBe(true)
    expect(logs.some((line) => line.includes('respawn failed'))).toBe(true)
  })
})

describe('MilvusLauncher uvx resolution', () => {
  it('finds uvx on PATH before probing ~/.local/bin', async () => {
    const dataDir = tempDataDir()
    const binDir = mkdtempSync(join(tmpdir(), 'membins-'))
    cleanups.push(() => rmSync(binDir, { recursive: true, force: true }))
    writeFileSync(join(binDir, 'uvx'), '#!/bin/sh\n')
    // accessSync(X_OK) in findUvx needs the executable bit to be set.
    chmodSync(join(binDir, 'uvx'), 0o755)
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir },
      spawner,
      env: { PATH: binDir },
      homedir: () => dataDir,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
    })

    await launcher.start()

    expect(calls[0]!.command).toBe(join(binDir, 'uvx'))
  })

  it('auto-installs uv when uvx is absent and reports offline on failure', async () => {
    const dataDir = tempDataDir()
    const { calls, spawner } = recordingSpawner((call) => {
      if (call.command === 'sh') {
        setImmediate(() => call.child.emitExit(127, null))
      }
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir },
      spawner,
      homedir: () => dataDir, // no .local/bin/uvx inside
      probeFactory: () => new FakeProbe({ isAlive: () => false, version: LITE_VERSION }),
    })

    await expect(launcher.start()).rejects.toThrow(/uvx not found[\s\S]*offline/)
    const installer = calls.find((call) => call.command === 'sh')
    expect(installer?.args).toEqual(['-c', expect.stringContaining('astral.sh/uv/install.sh')])
  })
})

describe('MilvusLauncher external mode', () => {
  it('skips spawning entirely and accepts any server version', async () => {
    const { calls, spawner } = recordingSpawner()
    const launcher = makeLauncher({
      dataDir: tempDataDir(),
      config: { mode: 'external', address: 'localhost:19530' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => true, version: 'v2.6.9-standalone' }),
    })

    const result = await launcher.start()

    expect(result).toEqual({
      address: 'localhost:19530',
      version: 'v2.6.9-standalone',
      spawned: false,
    })
    expect(calls).toHaveLength(0)
  })

  it('requires an address in external mode', async () => {
    const launcher = makeLauncher({
      dataDir: tempDataDir(),
      config: { mode: 'external' },
      spawner: recordingSpawner().spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => true, version: 'x' }),
    })

    await expect(launcher.start()).rejects.toThrow(/external.*requires config\.address/)
  })
})

describe('MilvusLauncher teardown', () => {
  it('kills SIGTERM then SIGKILL after grace and clears the port file', async () => {
    const dataDir = tempDataDir()
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
    })

    await launcher.start()
    const child = calls[0]!.child

    const disposal = launcher.dispose()
    child.emitExit(0, null)
    await disposal

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(() => readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')).toThrow()
    // disposed launcher refuses work and a second dispose is safe
    await launcher.dispose()
    await expect(launcher.start()).rejects.toThrow(/disposed/)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const dataDir = tempDataDir()
    let alive = false
    const { calls, spawner } = recordingSpawner(() => {
      alive = true
    })
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => alive, version: LITE_VERSION }),
      killGraceMs: 10,
    })

    await launcher.start()
    await launcher.dispose() // child never emits exit -> escalation

    expect(calls[0]!.child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('an attached (not owned) child is left running and its port file kept', async () => {
    const dataDir = tempDataDir()
    writeFileSync(join(dataDir, PORT_FILE_NAME), JSON.stringify({ port: 54_321, pid: 999 }))
    const launcher = makeLauncher({
      dataDir,
      config: { dataDir, uvxPath: '/fake/uvx' },
      spawner: recordingSpawner().spawner,
      probeFactory: () => new FakeProbe({ isAlive: () => true, version: LITE_VERSION }),
    })

    const result = await launcher.start()
    expect(result.spawned).toBe(false)
    await launcher.dispose()

    expect(readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')).toContain('54321')
  })
})

/** ReaddirNames lists directory entry names. */
function readdirNames(dir: string): string[] {
  return readdirSync(dir)
}
