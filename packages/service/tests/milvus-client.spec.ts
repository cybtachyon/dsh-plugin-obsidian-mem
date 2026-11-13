import { beforeEach, describe, expect, it, vi } from 'vitest'

// Spy the SDK module BEFORE importing the factory under test: every
// MilvusClient construction is captured so the settings that keep
// milvus-lite alive (G11: keepalive GOAWAY) and quiet (telemetry opt-out)
// are asserted against the real constructor call, not a reimplementation.
// The SDK resolves on server errors instead of rejecting (G1), so the
// spy also answers scripted statuses/rejections for the handshake and
// probe paths; TASK-060 keeps this the spy tier (the real gRPC stack is
// live-only, milvus-live.spec).
const constructed: Record<string, unknown>[] = []
const spy = {
  health: async () => ({ isHealthy: true, status: 'Online', inHealthy: true, status_name: '' }),
  version: async () => ({ version: 'milvus_lite-3.2.2' }),
  connect: () => Promise.resolve(),
  closedCount: 0,
}

vi.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config)
    }

    get connectPromise() {
      return spy.connect()
    }

    checkHealth() {
      return spy.health()
    }

    getVersion() {
      return spy.version()
    }

    async closeConnection() {
      spy.closedCount += 1
    }
  },
}))

// Imported after the vi.mock above on purpose: the mock factory must be
// registered before client.ts resolves the SDK module.
import {
  createMilvusClient,
  MILVUS_REQUEST_TIMEOUT_MS,
  probeFor,
  PROBE_TIMEOUT_MS,
  readyMilvusClient,
} from '../src/milvus/client.ts'

beforeEach(() => {
  constructed.length = 0
  spy.closedCount = 0
  spy.health = async () => ({ isHealthy: true, status: 'Online', inHealthy: true, status_name: '' })
  spy.version = async () => ({ version: 'milvus_lite-3.2.2' })
  spy.connect = () => Promise.resolve()
})

/**
 * TASK-025 carry-over #2: the keepalive suppression and telemetry opt-out
 * the live milvus-lite stack proved load-bearing (findings G11) must
 * survive any refactor of client.ts. This spec pins them at the SDK
 * boundary through a fake module.
 */
describe('milvus client SDK options', () => {

  it('pins keepalive past any session and opts telemetry out on every client', () => {
    createMilvusClient('127.0.0.1:19530')
    probeFor('127.0.0.1:19531')

    expect(constructed).toHaveLength(2)
    for (const config of constructed) {
      expect(config.channelOptions).toEqual({
        'grpc.keepalive_time_ms': 86_400_000,
        'grpc.keepalive_permit_without_calls': 0,
      })
      expect(config.telemetry).toEqual({ enabled: false })
      expect(config.pool).toEqual({ max: 4, min: 1 })
      expect(config.database).toBe('default')
    }
  })

  it('passes addresses and per-role timeouts through', () => {
    createMilvusClient('127.0.0.1:19530')
    expect(constructed[0]).toMatchObject({
      address: '127.0.0.1:19530',
      timeout: MILVUS_REQUEST_TIMEOUT_MS,
      logLevel: 'warn',
    })
    probeFor('127.0.0.1:19531')
    expect(constructed[1]).toMatchObject({
      address: '127.0.0.1:19531',
      timeout: PROBE_TIMEOUT_MS,
    })
  })
})

/**
 * TASK-060: readyMilvusClient is the launcher's gate before the long-lived
 * client is ever built (G12). The SDK resolves on error statuses instead
 * of rejecting (G1), so the handshake must run checkHealth AND getVersion
 * through assertOk, and every failure path must close the half-ready
 * client before rethrowing. Spy tier: statuses and rejections are
 * scripted, no gRPC.
 */
describe('readyMilvusClient handshake', () => {
  it('returns the client once connect, checkHealth, and getVersion all answer clean', async () => {
    const client = await readyMilvusClient('127.0.0.1:19530')

    expect(constructed).toHaveLength(1)
    expect(constructed[0]).toMatchObject({
      address: '127.0.0.1:19530',
      timeout: MILVUS_REQUEST_TIMEOUT_MS,
    })
    expect(await client.getVersion()).toEqual({ version: 'milvus_lite-3.2.2' })
    expect(spy.closedCount).toBe(0)
  })

  it('throws on an unhealthy status and closes the connection', async () => {
    spy.health = async () => ({
      isHealthy: false,
      error_code: 'UnexpectedError',
      reason: 'server state abnormally',
    })

    await expect(readyMilvusClient('127.0.0.1:19530')).rejects.toThrow(
      /milvus checkHealth: UnexpectedError server state abnormally/,
    )
    expect(spy.closedCount).toBe(1)
  })

  it('throws on an error-status getVersion and closes the connection', async () => {
    spy.version = async () => ({ error_code: 'NotReady', reason: 'server unknown' })

    await expect(readyMilvusClient('127.0.0.1:19530')).rejects.toThrow(
      /milvus getVersion: NotReady/,
    )
    expect(spy.closedCount).toBe(1)
  })

  it('closes and rethrows when the connect promise itself rejects', async () => {
    spy.connect = () => Promise.reject(new Error('14 UNAVAILABLE: no connection'))

    await expect(readyMilvusClient('127.0.0.1:19530')).rejects.toThrow('14 UNAVAILABLE: no connection')
    expect(spy.closedCount).toBe(1)
  })
})

/**
 * TASK-060: probeFor is the MilvusProbe the launcher polls during
 * attach/readiness. Its adapter must surface error statuses as throws
 * (launcher treats throw as "not ready yet", never trusts the payload),
 * pass clean payloads through untouched, and map close() onto
 * closeConnection.
 */
describe('probeFor adapter', () => {
  it('passes clean version and health payloads through to the launcher', async () => {
    const probe = probeFor('127.0.0.1:19531')

    await expect(probe.getVersion()).resolves.toEqual({ version: 'milvus_lite-3.2.2' })
    await expect(probe.checkHealth()).resolves.toMatchObject({ isHealthy: true })
    expect(probe.connectPromise).toBeDefined()

    await probe.close()
    expect(spy.closedCount).toBe(1)
  })

  it('turns an error status from either call into a throw', async () => {
    const probe = probeFor('127.0.0.1:19531')
    spy.version = async () => ({ error_code: 'NotReady', reason: 'bootstrap' })
    spy.health = async () => ({ error_code: 'NotReady', reason: 'bootstrap' })

    await expect(probe.getVersion()).rejects.toThrow(/milvus getVersion: NotReady bootstrap/)
    await expect(probe.checkHealth()).rejects.toThrow(/milvus checkHealth: NotReady bootstrap/)
  })
})
