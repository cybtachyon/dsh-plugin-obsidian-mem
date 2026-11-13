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
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { createServer } from 'node:net';
import { homedir as osHomedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dbDir } from '../../../core/lib/index.js';
import { describeError } from '../errors.js';
import { probeFor, PROBE_TIMEOUT_MS } from './client.js';
/**
 * MilvusLiteVersion pins the certified milvus-lite release passed to
 * `uvx --from milvus-lite==<PIN>`. 3.x storage is a directory layout 2.x
 * cannot read and there is no migration, so an upstream release must never
 * silently change storage semantics under a live index (findings §5.2.9).
 */
export const MILVUS_LITE_VERSION = '3.2.2';
/** LiteVersionPrefix is what identifies a lite server in getVersion output. */
export const LITE_VERSION_PREFIX = 'milvus_lite';
/** IsLiteVersion tests a getVersion answer for the milvus-lite server prefix. */
function isLiteVersion(version) {
    return version.startsWith(LITE_VERSION_PREFIX);
}
/** PortFileName is the port/pid record under dataDir; lite itself writes none. */
export const PORT_FILE_NAME = '.memlite.json';
/** UvInstallScript is the official installer used when uvx is absent. */
export const UV_INSTALL_SCRIPT = 'https://astral.sh/uv/install.sh';
// milvus-lite prints this exception name on stderr when another process
// owns the data-dir LOCK file (findings §2.3); it is the already-running
// signal.
const DATA_DIR_LOCK_MARKER = 'DataDirLockedError';
const DEFAULT_READINESS_TIMEOUT_MS = 90_000;
const DEFAULT_READINESS_INTERVAL_MS = 250;
// One probe budget, shared with the probe builder itself (client.ts).
const DEFAULT_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_RESPAWN_BASE_DELAY_MS = 1_000;
const DEFAULT_RESPAWN_MAX_DELAY_MS = 30_000;
const STDERR_TAIL_CHARS = 4_000;
/** Thrown when the data-dir LOCK belongs to another process. */
export class MilvusDataDirLockedError extends Error {
}
/** Thrown when a non-lite Milvus answers on the spawn-mode port. */
export class MilvusForeignServerError extends Error {
}
/**
 * MilvusLauncher implements the verified bootstrap lifecycle. Constructing
 * it starts nothing; start() attach-or-spawns single-flight, dispose() tears
 * down, and an unexpected child exit flips degraded and backs off to
 * respawn.
 */
export class MilvusLauncher {
    config;
    spawner;
    probeFactory;
    env;
    homedir;
    log;
    readinessTimeoutMs;
    readinessIntervalMs;
    probeTimeoutMs;
    killGraceMs;
    respawnBaseDelayMs;
    respawnMaxDelayMs;
    startPromise = null;
    activeResult = null;
    child = null;
    ownedPortFile = null;
    killedChildren = new Set();
    respawnTimer = null;
    respawnAttempt = 0;
    degradedState = false;
    disposed = false;
    constructor(options = {}) {
        this.config = options.config ?? {};
        this.spawner = options.spawner ?? defaultSpawner;
        this.env = options.env ?? process.env;
        this.homedir = options.homedir ?? osHomedir;
        this.log = options.log ?? ((message) => console.warn(`[obsidian-mem] ${message}`));
        this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
        this.readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
        this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this.probeFactory = options.probeFactory
            ?? ((address) => probeFor(address, this.probeTimeoutMs));
        this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        this.respawnBaseDelayMs = options.respawnBaseDelayMs ?? DEFAULT_RESPAWN_BASE_DELAY_MS;
        this.respawnMaxDelayMs = options.respawnMaxDelayMs ?? DEFAULT_RESPAWN_MAX_DELAY_MS;
    }
    /** Degraded reports a dead owned child awaiting respawn (index offline). */
    get degraded() {
        return this.degradedState;
    }
    /** Address reports the live backend, or null before start / after crash. */
    get address() {
        return this.activeResult?.address ?? null;
    }
    /** OwnedChild exposes the live spawned child for status and tests. */
    get ownedChild() {
        return this.child;
    }
    /**
     * Start attaches to a live lite server or spawns one, returning once the
     * backend is health-checked. Concurrent calls share one flight.
     */
    start() {
        if (this.disposed) {
            return Promise.reject(new Error('milvus launcher: already disposed'));
        }
        if (this.activeResult) {
            return Promise.resolve(this.activeResult);
        }
        this.startPromise ??= this.runStart().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }
    /**
     * Dispose stops respawns, kills an owned child SIGTERM then SIGKILL after
     * the grace window (lite has no shutdown RPC), and clears the port file.
     */
    async dispose() {
        this.disposed = true;
        if (this.respawnTimer) {
            clearTimeout(this.respawnTimer);
            this.respawnTimer = null;
        }
        const child = this.child;
        this.child = null;
        this.activeResult = null;
        if (!child) {
            return;
        }
        this.killedChildren.add(child);
        child.kill('SIGTERM');
        const exited = await this.childExitAfterKill(child);
        if (!exited) {
            child.kill('SIGKILL');
        }
        this.removePortFile(this.ownedPortFile);
        this.ownedPortFile = null;
    }
    async runStart() {
        if (this.config.mode === 'external') {
            return await this.startExternal();
        }
        return await this.attachOrSpawn();
    }
    /** StartExternal connects to a user-managed Milvus and never spawns. */
    async startExternal() {
        const address = this.config.address;
        if (!address) {
            throw new Error('milvus launcher: mode "external" requires config.address (host:port)');
        }
        const version = await this.waitForReady(address, null);
        const result = { address, version, spawned: false };
        this.activeResult = result;
        return result;
    }
    /**
     * AttachOrSpawn follows findings §5.2: legacy-layout check, port file,
     * attach-if-ours probe, uvx resolution, the pinned spawn command,
     * readiness, and the lock-owner path.
     */
    async attachOrSpawn() {
        const dataDir = this.config.dataDir ?? dbDir(this.homedir());
        this.retireLegacyDataDir(dataDir);
        mkdirSync(dataDir, { recursive: true });
        const portFile = join(dataDir, PORT_FILE_NAME);
        const recorded = readPortFile(portFile);
        const candidatePort = this.config.port ?? recorded?.port;
        if (candidatePort !== undefined) {
            const attached = await this.tryAttach(`127.0.0.1:${candidatePort}`);
            if (attached) {
                return attached;
            }
        }
        const uvxPath = await this.ensureUvx();
        const port = candidatePort ?? await freePort();
        const address = `127.0.0.1:${port}`;
        const watch = { exit: null, stderrText: '' };
        const child = this.spawnLite(uvxPath, dataDir, port, watch);
        try {
            if (child.pid !== undefined) {
                writePortFile(portFile, { port, pid: child.pid });
                this.ownedPortFile = portFile;
            }
            const version = await this.waitForReady(address, watch);
            const result = { address, version, spawned: true };
            this.child = child;
            this.activeResult = result;
            this.degradedState = false;
            this.respawnAttempt = 0;
            return result;
        }
        catch (error) {
            const childExited = watch.exit !== null;
            if (error instanceof MilvusDataDirLockedError) {
                const attached = recorded
                    ? await this.tryAttach(`127.0.0.1:${recorded.port}`)
                    : null;
                if (attached) {
                    // The live owner's record was clobbered by ours; restore it so a
                    // future restart can find the owner's port again.
                    writePortFile(portFile, recorded);
                    return attached;
                }
                this.removePortFile(portFile);
                this.ownedPortFile = null;
                throw new MilvusDataDirLockedError(`another process holds the lock on ${dataDir} (DataDirLockedError) and no live `
                    + `milvus-lite answered at ${recorded ? `127.0.0.1:${recorded.port}` : 'a recorded port'}. `
                    + 'Stop the other plugin instance or point config at it with '
                    + `{ mode: 'external', address: '127.0.0.1:<port>' }; never retry blind.`);
            }
            if (!childExited) {
                this.killedChildren.add(child);
                child.kill('SIGTERM');
            }
            this.removePortFile(portFile);
            this.ownedPortFile = null;
            throw error;
        }
    }
    /** TryAttach attaches when a milvus-lite answers; foreign servers throw. */
    async tryAttach(address) {
        try {
            const { version } = await this.probeVersion(address);
            if (!isLiteVersion(version)) {
                throw new MilvusForeignServerError(`a non-milvus-lite Milvus (${version || 'unknown version'}) answers at ${address}. `
                    + `Spawn mode refuses it; run it as { mode: 'external', address: '${address}' } `
                    + 'or free the port.');
            }
            const result = { address, version, spawned: false };
            this.activeResult = result;
            return result;
        }
        catch (error) {
            if (error instanceof MilvusForeignServerError) {
                throw error;
            }
            return null; // nothing answering: not attachable
        }
    }
    /**
     * WithProbe opens one short-lived probe against address, waits for its
     * channel, hands it to `use`, and always releases it. Every probe this
     * launcher opens goes through here, so no path leaks a connection pool.
     */
    async withProbe(address, use) {
        const probe = this.probeFactory(address);
        try {
            if (probe.connectPromise) {
                await probe.connectPromise;
            }
            return await use(probe);
        }
        finally {
            await Promise.resolve(probe.close()).catch(() => undefined);
        }
    }
    /** ProbeVersion asks one fresh probe for the server version string. */
    probeVersion(address) {
        return this.withProbe(address, (probe) => probe.getVersion());
    }
    /** SpawnLite runs the one command verified in findings §5.1, pinned. */
    spawnLite(uvxPath, dataDir, port, watch) {
        const args = [
            '--with', 'pymilvus', // mandatory: milvus-lite omits pymilvus (§5.1)
            '--from', `milvus-lite==${MILVUS_LITE_VERSION}`,
            'milvus-lite', 'server',
            '--data-dir', dataDir,
            '--host', '127.0.0.1', // mandatory: default 0.0.0.0 has no auth (§5.1)
            '--port', String(port),
        ];
        const child = this.spawner(uvxPath, args, {
            env: { ...this.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
        child.stderr?.on('data', (chunk) => {
            watch.stderrText = (watch.stderrText + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        });
        child.once('exit', (code, signal) => {
            watch.exit = { code, signal };
            this.onChildExit(child, code, signal);
        });
        return child;
    }
    /**
     * WaitForReady is the SDK-3.0.6 replacement for the nonexistent
     * waitForMilvusReady: poll health + version until the deadline
     * (findings §4.1, §5.2.4). Each poll builds a FRESH probe client: a gRPC
     * channel constructed against a not-yet-listening port never recovers
     * against milvus-lite (verified 2026-11-12: TCP opens later, but the
     * stuck channel answers UNAVAILABLE forever), while a client constructed
     * after the port listens connects immediately.
     */
    async waitForReady(address, watch) {
        const deadline = Date.now() + this.readinessTimeoutMs;
        let lastError = null;
        for (;;) {
            if (watch?.exit) {
                throw this.childDiedError(address, watch);
            }
            try {
                const version = await this.withProbe(address, async (probe) => {
                    const health = await probe.checkHealth();
                    return health.isHealthy ? (await probe.getVersion()).version : null;
                });
                if (version !== null) {
                    if (this.config.mode !== 'external' && !isLiteVersion(version)) {
                        throw new MilvusForeignServerError(`the server spawned for ${address} reports ${version}, not ${LITE_VERSION_PREFIX}-*; `
                            + `the version pin guards the 3.x storage layout`);
                    }
                    return version;
                }
            }
            catch (error) {
                if (error instanceof MilvusForeignServerError) {
                    throw error;
                }
                lastError = error;
            }
            if (Date.now() >= deadline) {
                break;
            }
            await sleep(this.readinessIntervalMs);
        }
        throw new Error(`milvus launcher: no healthy milvus-lite at ${address} within ${this.readinessTimeoutMs} ms `
            + `(cold uvx resolves and downloads the wheel set once; warm starts take ~0.5 s). `
            + `Last error: ${describeError(lastError)}`);
    }
    /** ChildDiedError classifies a spawn that exited before readiness. */
    childDiedError(address, watch) {
        const tail = watch.stderrText.trim();
        if (watch.stderrText.includes(DATA_DIR_LOCK_MARKER)) {
            return new MilvusDataDirLockedError(`milvus-lite for ${address} exited: ${DATA_DIR_LOCK_MARKER}; stderr: ${tail}`);
        }
        return new Error(`milvus-lite for ${address} exited before ready `
            + `(code=${watch.exit?.code} signal=${watch.exit?.signal}). `
            + `stderr tail: ${tail || '(empty)'}`);
    }
    /** OnChildExit flips degraded and schedules a backed-off respawn. */
    onChildExit(child, code, signal) {
        if (this.disposed || this.killedChildren.has(child) || this.child !== child) {
            return;
        }
        this.child = null;
        this.activeResult = null;
        this.degradedState = true;
        this.log(`milvus-lite child (pid ${child.pid ?? '?'}) exited unexpectedly `
            + `(code=${code} signal=${signal}); index offline until respawn `
            + `(attempt ${this.respawnAttempt + 1})`);
        this.scheduleRespawn();
    }
    scheduleRespawn() {
        if (this.disposed || this.respawnTimer) {
            return;
        }
        const delay = Math.min(this.respawnBaseDelayMs * 2 ** this.respawnAttempt, this.respawnMaxDelayMs);
        this.respawnAttempt += 1;
        this.respawnTimer = setTimeout(() => {
            this.respawnTimer = null;
            if (this.disposed) {
                return;
            }
            this.start().then((result) => {
                this.degradedState = false;
                this.log(`milvus-lite respawned at ${result.address} (${result.version})`);
            }, (error) => {
                this.log(`milvus-lite respawn failed: ${describeError(error)}; backing off`);
                this.scheduleRespawn();
            });
        }, delay);
        this.respawnTimer.unref?.();
    }
    /** EnsureUvx probes PATH then ~/.local/bin, then tries the official install. */
    async ensureUvx() {
        if (this.config.uvxPath) {
            return this.config.uvxPath;
        }
        const found = this.findUvx();
        if (found) {
            return found;
        }
        this.log(`uvx not found on PATH or ~/.local/bin; installing uv from ${UV_INSTALL_SCRIPT}`);
        const installed = await this.installUv();
        if (installed) {
            return installed;
        }
        throw new Error('milvus launcher: uvx not found and uv auto-install failed. If this machine is '
            + `offline, copy uvx in place or set the uvxPath config. Manual install: `
            + `curl -LsSf ${UV_INSTALL_SCRIPT} | sh (https://docs.astral.sh/uv/), then retry.`);
    }
    findUvx() {
        const directories = [
            ...(this.env.PATH ?? '').split(delimiter).filter(Boolean),
            join(this.homedir(), '.local', 'bin'), // the uv installer's target
        ];
        for (const directory of directories) {
            const candidate = join(directory, 'uvx');
            try {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
            catch {
                // keep looking
            }
        }
        return null;
    }
    /**
     * InstallUv runs the official astral installer through the spawner. It
     * needs network; offline it fails and findUvx still returns null, which
     * turns into the actionable uvx-not-found error.
     */
    async installUv() {
        try {
            const child = this.spawner('sh', ['-c', `curl -LsSf ${UV_INSTALL_SCRIPT} | sh`], {
                env: { ...this.env },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false,
            });
            const code = await new Promise((resolve) => {
                child.once('exit', (exitCode) => resolve(exitCode));
            });
            if (code !== 0) {
                this.log(`uv installer exited with code ${code}`);
            }
            return this.findUvx();
        }
        catch (error) {
            this.log(`uv auto-install failed: ${describeError(error)}`);
            return null;
        }
    }
    /**
     * RetireLegacyDataDir moves aside a milvus-lite 2.x single-file database
     * before 3.x starts in the same path. 3.x cannot read 2.x files and the
     * upstream provides no migration, so the loud move-plus-rebuild is the
     * only honest path (RESEARCH-FINDINGS scar tissue; findings §2.3).
     */
    retireLegacyDataDir(dataDir) {
        let stats;
        try {
            stats = statSync(dataDir);
        }
        catch {
            return; // fresh path: nothing to retire
        }
        if (!stats.isFile()) {
            return;
        }
        const moved = `${dataDir}.legacy-2x-${Date.now()}`;
        renameSync(dataDir, moved);
        this.log(`milvus-lite: moved legacy 2.x single-file database ${dataDir} to ${moved}; `
            + '3.x cannot read 2.x databases and no migration exists. The index rebuilds from the vaults.');
    }
    /** ChildExitAfterKill waits graceMs for the killed child to exit. */
    childExitAfterKill(child) {
        return new Promise((resolve) => {
            let settled = false;
            const settle = (exited) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(exited);
            };
            const timer = setTimeout(() => settle(false), this.killGraceMs);
            timer.unref?.();
            child.once('exit', () => settle(true));
        });
    }
    removePortFile(portFile) {
        if (!portFile) {
            return;
        }
        try {
            unlinkSync(portFile);
        }
        catch {
            // already gone: nothing to undo
        }
    }
}
/** DefaultSpawner is the production LiteSpawner over node:child_process. */
const defaultSpawner = (command, args, options) => nodeSpawn(command, [...args], options);
/** FreePort asks the OS for an unused ephemeral TCP port on loopback. */
async function freePort() {
    const server = createServer();
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address();
    await new Promise((resolve) => {
        server.close(() => resolve());
    });
    return port;
}
/** ReadPortFile parses <dataDir>/.memlite.json; unreadable files are absent. */
function readPortFile(portFile) {
    try {
        const parsed = JSON.parse(readFileSync(portFile, 'utf8'));
        if (typeof parsed?.port !== 'number' || !Number.isInteger(parsed.port)) {
            return null;
        }
        return { port: parsed.port, pid: typeof parsed.pid === 'number' ? parsed.pid : null };
    }
    catch {
        return null;
    }
}
/** WritePortFile persists the {port,pid} record for a restart to reuse/reap. */
function writePortFile(portFile, record) {
    writeFileSync(portFile, `${JSON.stringify(record)}\n`);
}
/** Sleep resolves after ms. */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
//# sourceMappingURL=launcher.js.map
