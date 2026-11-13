import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  MILVUS_LITE_VERSION,
  MilvusLauncher,
  PORT_FILE_NAME,
} from '../src/milvus/launcher.ts'

/**
 * Live bootstrap tier: spawns a real uvx-managed milvus-lite into a tmp
 * data dir, health-handshakes it over gRPC, and asserts the child dies on
 * dispose. Skipped unless RUN_LIVE=1 (cold uvx downloads the wheel set and
 * can take a minute).
 */

const describeLive = process.env.RUN_LIVE === '1' ? describe : describe.skip

describeLive('milvus-lite live bootstrap (RUN_LIVE=1)', () => {
  it(
    'spawns via uvx, reports the pinned version, and kills the child on dispose',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'memlite-live-'))
      const logs: string[] = []
      const launcher = new MilvusLauncher({
        config: { dataDir },
        homedir: () => dataDir,
        log: (message) => logs.push(message),
      })
      let pid: number | undefined
      try {
        const result = await launcher.start()

        expect(result.spawned).toBe(true)
        expect(result.address).toMatch(/^127\.0\.0\.1:\d+$/)
        expect(result.version).toBe(`milvus_lite-${MILVUS_LITE_VERSION}`)

        const portFile = JSON.parse(readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')) as {
          port: number
          pid: number | null
        }
        expect(portFile.port).toBe(Number(result.address.split(':').at(-1)))
        pid = launcher.ownedChild?.pid
        expect(portFile.pid).toBe(pid)
        expect(pid).toBeTypeOf('number')
        expect(process.kill(pid!, 0)).toBe(true)

        const disposal = launcher.dispose()
        await disposal

        // SIGTERM teardown completed: the pid is gone (node reaps its own
        // child, so a dead child surfaces as ESRCH).
        await vi.waitFor(() => expect(childAlive(pid!)).toBe(false), { timeout: 10_000 })
        expect(() => readFileSync(join(dataDir, PORT_FILE_NAME), 'utf8')).toThrow()
      } finally {
        if (pid !== undefined && childAlive(pid)) {
          process.kill(pid, 'SIGKILL')
        }
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    240_000,
  )
})

/** ChildAlive reports whether a pid still exists. */
function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
