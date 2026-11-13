import { beforeEach, describe, expect, it, vi } from 'vitest'

// Spy the SDK module BEFORE importing the factory under test: every
// MilvusClient construction is captured so the settings that keep
// milvus-lite alive (G11: keepalive GOAWAY) and quiet (telemetry opt-out)
// are asserted against the real constructor call, not a reimplementation.
const constructed: Record<string, unknown>[] = []
vi.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config)
    }

    connectPromise = Promise.resolve()
    async checkHealth() {
      return { isHealthy: true, status: 'Online', inHealthy: true, status_name: '' }
    }

    async getVersion() {
      return { version: 'milvus_lite-3.2.2' }
    }

    async closeConnection() {}
  },
}))

// Imported after the vi.mock above on purpose: the mock factory must be
// registered before client.ts resolves the SDK module.
import {
  createMilvusClient,
  MILVUS_REQUEST_TIMEOUT_MS,
  probeFor,
  PROBE_TIMEOUT_MS,
} from '../src/milvus/client.ts'

/**
 * TASK-025 carry-over #2: the keepalive suppression and telemetry opt-out
 * the live milvus-lite stack proved load-bearing (findings G11) must
 * survive any refactor of client.ts. This spec pins them at the SDK
 * boundary through a fake module.
 */
describe('milvus client SDK options', () => {
  beforeEach(() => {
    constructed.length = 0
  })

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
