/**
 * Client builds the long-lived @zilliz/milvus2-sdk-node connections for the
 * obsidian-mem service: the production MilvusClient factory plus the probe
 * shape the launcher uses for attach/readiness checks.
 *
 * The SDK resolves on server errors instead of throwing, so every response
 * must pass assertOk (milvus/ok.ts) before its payload is trusted.
 * @module dsh-plugin-obsidian-mem/service/milvus/client
 */
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
/** Default gRPC request budget for plugin calls, in ms. */
export declare const MILVUS_REQUEST_TIMEOUT_MS = 60000;
/**
 * PROBE_TIMEOUT_MS bounds one launcher probe: an attach or readiness check
 * must fail fast enough that the poll loop keeps its own cadence, and
 * launcher.ts defaults probeTimeoutMs to this same number.
 */
export declare const PROBE_TIMEOUT_MS = 2000;
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
export declare function createMilvusClient(address: string, timeoutMs?: number): MilvusClient;
/**
 * ReadyMilvusClient connects, then handshake-verifies the server: SDK
 * 3.0.6 has no waitForMilvusReady, so connectPromise + checkHealth +
 * getVersion is the verified replacement (findings §4.1, §5.2.4).
 */
export declare function readyMilvusClient(address: string, timeoutMs?: number): Promise<MilvusClient>;
/**
 * MilvusProbe is the launcher-facing slice of a client: version and health
 * only. Unit tests inject stub probes; production uses ProbeFor.
 */
export interface MilvusProbe {
    /** Answers the server version, e.g. `milvus_lite-3.2.2`. */
    getVersion(): Promise<{
        version: string;
    }>;
    /** Reports gRPC-level health; not the same as TCP accept. */
    checkHealth(): Promise<{
        isHealthy: boolean;
    }>;
    /** Resolves when the gRPC channel is established, if the client exposes one. */
    readonly connectPromise?: Promise<unknown>;
    /** Releases the connection pool. */
    close(): void | Promise<void>;
}
/** ProbeFactory opens a short-lived probe against host:port. */
export type ProbeFactory = (address: string) => MilvusProbe;
/**
 * ProbeFor opens a real short-timeout probe client for launcher attach
 * checks and readiness polling.
 */
export declare function probeFor(address: string, timeoutMs?: number): MilvusProbe;
//# sourceMappingURL=client.d.ts.map
