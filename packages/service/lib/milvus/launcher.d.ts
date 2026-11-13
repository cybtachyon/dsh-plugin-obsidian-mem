/**
 * Launcher owns the Milvus-Lite child process: uvx resolution, the verified
 * spawn command, the <dataDir>/.memlite.json port/pid file,
 * attach-before-spawn, readiness polling, lock-owner handling, degraded-mode
 * respawn with backoff, and SIGTERM/SIGKILL teardown.
 *
 * Start is lazy by contract: only `ensureMemoryAccess()` (TASK-030) calls
 * start(), so an unconfigured install spawns no child process. The bootstrap
 * command and the algorithm are copied verbatim from
 * docs/research/milvus-transformers-findings.md §5.1-5.2; do not re-derive.
 * @module dsh-plugin-obsidian-mem/service/milvus/launcher
 */
import type { ProbeFactory } from './client.js';
/**
 * MilvusLiteVersion pins the certified milvus-lite release passed to
 * `uvx --from milvus-lite==<PIN>`. 3.x storage is a directory layout 2.x
 * cannot read and there is no migration, so an upstream release must never
 * silently change storage semantics under a live index (findings §5.2.9).
 */
export declare const MILVUS_LITE_VERSION = "3.2.2";
/** LiteVersionPrefix is what identifies a lite server in getVersion output. */
export declare const LITE_VERSION_PREFIX = "milvus_lite";
/** PortFileName is the port/pid record under dataDir; lite itself writes none. */
export declare const PORT_FILE_NAME = ".memlite.json";
/** UvInstallScript is the official installer used when uvx is absent. */
export declare const UV_INSTALL_SCRIPT = "https://astral.sh/uv/install.sh";
/** Launcher mode: 'spawn' owns a child; 'external' only connects. */
export type MilvusLauncherMode = 'spawn' | 'external';
/** Config for the Milvus-Lite backend. */
export interface MilvusLauncherConfig {
    /** Default 'spawn'. 'external' skips spawning and uses address. */
    mode?: MilvusLauncherMode;
    /** external mode: host:port of an already-running Milvus. */
    address?: string;
    /** spawn mode: fixed localhost port; default: free ephemeral port. */
    port?: number;
    /** lite data directory (3.x: a directory, not a file); default dbDir(homedir()). */
    dataDir?: string;
    /** uvx path override; default: probe PATH then ~/.local/bin. */
    uvxPath?: string;
}
/** Minimal process view the launcher needs; ChildProcess satisfies it. */
export interface LiteChild {
    readonly pid?: number | undefined;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    readonly stderr: {
        on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
    } | null;
}
/** Spawn options the launcher always passes. */
export interface LiteSpawnOptions {
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'];
    detached: false;
}
/** LiteSpawner injects the process factory; tests stub it, production spawns. */
export type LiteSpawner = (command: string, args: readonly string[], options: LiteSpawnOptions) => LiteChild;
/** Seeded constructor options; every process/client touch point is injectable. */
export interface MilvusLauncherOptions {
    config?: MilvusLauncherConfig;
    spawner?: LiteSpawner;
    probeFactory?: ProbeFactory;
    /** env for uvx resolution and children; default process.env. */
    env?: NodeJS.ProcessEnv;
    /** Home base for dataDir and ~/.local/bin defaults. */
    homedir?: () => string;
    /** Loud lines (degraded state, legacy moves); default console.warn. */
    log?: (message: string) => void;
    readinessTimeoutMs?: number;
    readinessIntervalMs?: number;
    probeTimeoutMs?: number;
    killGraceMs?: number;
    respawnBaseDelayMs?: number;
    respawnMaxDelayMs?: number;
}
/** What a successful start() reports. */
export interface MilvusStartResult {
    /** host:port the service connects to. */
    address: string;
    /** Server version from getVersion, e.g. `milvus_lite-3.2.2`. */
    version: string;
    /** True when this launcher spawned the child; false on attach/external. */
    spawned: boolean;
}
/** Thrown when the data-dir LOCK belongs to another process. */
export declare class MilvusDataDirLockedError extends Error {
}
/** Thrown when a non-lite Milvus answers on the spawn-mode port. */
export declare class MilvusForeignServerError extends Error {
}
/**
 * MilvusLauncher implements the verified bootstrap lifecycle. Constructing
 * it starts nothing; start() attach-or-spawns single-flight, dispose() tears
 * down, and an unexpected child exit flips degraded and backs off to
 * respawn.
 */
export declare class MilvusLauncher {
    private readonly config;
    private readonly spawner;
    private readonly probeFactory;
    private readonly env;
    private readonly homedir;
    private readonly log;
    private readonly readinessTimeoutMs;
    private readonly readinessIntervalMs;
    private readonly probeTimeoutMs;
    private readonly killGraceMs;
    private readonly respawnBaseDelayMs;
    private readonly respawnMaxDelayMs;
    private startPromise;
    private activeResult;
    private child;
    private ownedPortFile;
    private readonly killedChildren;
    private respawnTimer;
    private respawnAttempt;
    private degradedState;
    private disposed;
    constructor(options?: MilvusLauncherOptions);
    /** Degraded reports a dead owned child awaiting respawn (index offline). */
    get degraded(): boolean;
    /** Address reports the live backend, or null before start / after crash. */
    get address(): string | null;
    /** OwnedChild exposes the live spawned child for status and tests. */
    get ownedChild(): LiteChild | null;
    /**
     * Start attaches to a live lite server or spawns one, returning once the
     * backend is health-checked. Concurrent calls share one flight.
     */
    start(): Promise<MilvusStartResult>;
    /**
     * Dispose stops respawns, kills an owned child SIGTERM then SIGKILL after
     * the grace window (lite has no shutdown RPC), and clears the port file.
     */
    dispose(): Promise<void>;
    private runStart;
    /** StartExternal connects to a user-managed Milvus and never spawns. */
    private startExternal;
    /**
     * AttachOrSpawn follows findings §5.2: legacy-layout check, port file,
     * attach-if-ours probe, uvx resolution, the pinned spawn command,
     * readiness, and the lock-owner path.
     */
    private attachOrSpawn;
    /** TryAttach attaches when a milvus-lite answers; foreign servers throw. */
    private tryAttach;
    /**
     * WithProbe opens one short-lived probe against address, waits for its
     * channel, hands it to `use`, and always releases it. Every probe this
     * launcher opens goes through here, so no path leaks a connection pool.
     */
    private withProbe;
    /** ProbeVersion asks one fresh probe for the server version string. */
    private probeVersion;
    /** SpawnLite runs the one command verified in findings §5.1, pinned. */
    private spawnLite;
    /**
     * WaitForReady is the SDK-3.0.6 replacement for the nonexistent
     * waitForMilvusReady: poll health + version until the deadline
     * (findings §4.1, §5.2.4). Each poll builds a FRESH probe client: a gRPC
     * channel constructed against a not-yet-listening port never recovers
     * against milvus-lite (verified 2026-11-12: TCP opens later, but the
     * stuck channel answers UNAVAILABLE forever), while a client constructed
     * after the port listens connects immediately.
     */
    private waitForReady;
    /** ChildDiedError classifies a spawn that exited before readiness. */
    private childDiedError;
    /** OnChildExit flips degraded and schedules a backed-off respawn. */
    private onChildExit;
    private scheduleRespawn;
    /** EnsureUvx probes PATH then ~/.local/bin, then tries the official install. */
    private ensureUvx;
    private findUvx;
    /**
     * InstallUv runs the official astral installer through the spawner. It
     * needs network; offline it fails and findUvx still returns null, which
     * turns into the actionable uvx-not-found error.
     */
    private installUv;
    /**
     * RetireLegacyDataDir moves aside a milvus-lite 2.x single-file database
     * before 3.x starts in the same path. 3.x cannot read 2.x files and the
     * upstream provides no migration, so the loud move-plus-rebuild is the
     * only honest path (docs/research/milvus-transformers-findings.md §2.3).
     */
    private retireLegacyDataDir;
    /** ChildExitAfterKill waits graceMs for the killed child to exit. */
    private childExitAfterKill;
    private removePortFile;
}
//# sourceMappingURL=launcher.d.ts.map
