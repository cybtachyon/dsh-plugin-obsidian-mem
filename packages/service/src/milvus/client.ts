/**
 * Client builds the long-lived @zilliz/milvus2-sdk-node connections for the
 * obsidian-mem service: the production MilvusClient factory plus the probe
 * shape the launcher uses for attach/readiness checks.
 *
 * The SDK resolves on server errors instead of throwing, so every response
 * must pass assertOk (milvus/ok.ts) before its payload is trusted.
 * @module dsh-plugin-obsidian-mem/service/milvus/client
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node'

import { assertOk } from './ok.js'

/** Default gRPC request budget for plugin calls, in ms. */
export const MILVUS_REQUEST_TIMEOUT_MS = 60_000

// The SDK's BaseClient forces keepalive pings every 10 s with
// keepalive_permit_without_calls=1. milvus-lite's pure-Python gRPC server
// enforces an HTTP/2 keepalive policy and answers that with GOAWY
// ENHANCE_YOUR_CALM ("rejected ... because of excess pings"); the channel
// then reports UNAVAILABLE forever, even though the TCP port stays open.
// Full Milvus (Go) tolerates the SDK defaults; lite does not (verified on
// 3.2.2, 2026-11-12). Pinning the interval past any realistic session
// stops the pings; loopback TCP needs no app-level keepalive.
const KEEPALIVE_SUPPRESSION = {
  'grpc.keepalive_time_ms': 86_400_000,
  'grpc.keepalive_permit_without_calls': 0,
}

/**
 * CreateMilvusClient constructs a client for a host:port gRPC address
 * (Milvus-Lite binds 127.0.0.1; lite has no auth, so no token is ever
 * sent). Keepalive pings are suppressed (see KEEPALIVE_SUPPRESSION).
 * Consistency is pinned Strong at createCollection and on the
 * read calls (SDK 3.0.6 ClientConfig has no client-level
 * consistency_level field), telemetry is opted out (3.0.x enables it by
 * default), and the pool stays small: one local process is the whole
 * audience.
 */
export function createMilvusClient(
  address: string,
  timeoutMs: number = MILVUS_REQUEST_TIMEOUT_MS,
): MilvusClient {
  return new MilvusClient({
    address,
    database: 'default',
    timeout: timeoutMs,
    logLevel: 'warn',
    telemetry: { enabled: false },
    pool: { max: 4, min: 1 },
    channelOptions: { ...KEEPALIVE_SUPPRESSION },
  })
}

/**
 * ReadyMilvusClient connects, then handshake-verifies the server: SDK
 * 3.0.6 has no waitForMilvusReady, so connectPromise + checkHealth +
 * getVersion is the verified replacement (findings §4.1, §5.2.4).
 */
export async function readyMilvusClient(
  address: string,
  timeoutMs: number = MILVUS_REQUEST_TIMEOUT_MS,
): Promise<MilvusClient> {
  const client = createMilvusClient(address, timeoutMs)
  try {
    await client.connectPromise
    assertOk(await client.checkHealth(), 'checkHealth')
    assertOk(await client.getVersion(), 'getVersion')
  } catch (error) {
    client.closeConnection().catch(() => undefined)
    throw error
  }
  return client
}

/**
 * MilvusProbe is the launcher-facing slice of a client: version and health
 * only. Unit tests inject stub probes; production uses ProbeFor.
 */
export interface MilvusProbe {
  /** Answers the server version, e.g. `milvus_lite-3.2.2`. */
  getVersion(): Promise<{ version: string }>
  /** Reports gRPC-level health; not the same as TCP accept. */
  checkHealth(): Promise<{ isHealthy: boolean }>
  /** Resolves when the gRPC channel is established, if the client exposes one. */
  readonly connectPromise?: Promise<unknown>
  /** Releases the connection pool. */
  close(): void | Promise<void>
}

/** ProbeFactory opens a short-lived probe against host:port. */
export type ProbeFactory = (address: string) => MilvusProbe

/**
 * ProbeFor opens a real short-timeout probe client for launcher attach
 * checks and readiness polling.
 */
export function probeFor(address: string, timeoutMs = 2_000): MilvusProbe {
  const client = createMilvusClient(address, timeoutMs)
  return {
    getVersion: async () => {
      return assertOk(await client.getVersion(), 'getVersion')
    },
    checkHealth: async () => {
      return assertOk(await client.checkHealth(), 'checkHealth')
    },
    connectPromise: client.connectPromise,
    close: async () => {
      await client.closeConnection()
    },
  }
}
