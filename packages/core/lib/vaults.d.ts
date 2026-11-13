/**
 * Models the vault registry: VaultConfig entries, side-effect-free
 * validation against an fs probe, the lazy default-vault provisioning seam,
 * shared-vault selection, path classification for the read/write guards, and
 * idempotent .INTENTS.md seeding.
 *
 * Pure against injected seams: resolveVaults never creates anything, and
 * provisioning happens only through provisionDefaultVault, which the service
 * calls from its first-memory-access seam (never at activation).
 * @module dsh-plugin-obsidian-mem/core/vaults
 */
import type { IntentMarker } from './constants.js';
/** Mode with full access: the plugin indexes and writes into the vault. */
export declare const VAULT_MODE_SHARED = "shared";
/** Mode with recall only: the plugin reads and never writes the vault. */
export declare const VAULT_MODE_READ_ONLY = "read-only";
/** The two access modes; resolveVaults validation and the type share it. */
export declare const VAULT_MODES: readonly ["shared", "read-only"];
/** One of the two vault access modes. */
export type VaultMode = typeof VAULT_MODES[number];
/** Tests whether value names one of the two vault modes. */
export declare function isVaultMode(value: string): value is VaultMode;
/**
 * A registered vault: an absolute path, its access mode, and the vault-root
 * relative path of its global memory file. globalFile is always resolved:
 * resolveVaults defaults a blank or omitted VaultConfigLike value to
 * GLOBAL_MEMORY_FILE_DEFAULT.
 */
export interface VaultConfig {
    path: string;
    mode: VaultMode;
    /** Vault-root-relative path of this vault's global memory file. */
    globalFile: string;
}
/**
 * FsProbe is the read-only fs surface vault validation needs. The service
 * implements it over node:fs; tests pass an in-memory stub.
 */
export interface FsProbe {
    /** Reports whether the path exists (file or directory). */
    exists(path: string): boolean;
    /** Returns the canonical location a path resolves to. */
    realpath(path: string): string;
}
/**
 * VaultFs adds the write surface provisioning and seeding need. All paths
 * reaching a seam are already absolute; the seam must not reinterpret them.
 */
export interface VaultFs extends FsProbe {
    /** Creates the directory and any missing parents (mkdir -p semantics). */
    mkdirp(path: string): void;
    /** Reads a UTF-8 file, or returns null when it does not exist. */
    readFile(path: string): string | null;
    /** Writes the UTF-8 contents, replacing any previous file. */
    writeFile(path: string, contents: string): void;
}
/** The wider record resolveVaults validates: mode arrives as user config. */
export interface VaultConfigLike {
    path: string;
    mode: string;
    /** Blank or omitted resolves to GLOBAL_MEMORY_FILE_DEFAULT. */
    globalFile?: string;
}
/** Why resolveVaults dropped one candidate config. */
export type VaultRejectKind = 'path-not-absolute' | 'path-missing' | 'mode-invalid' | 'duplicate';
/** One rejected candidate, kept so callers can report every problem. */
export interface VaultRejection {
    config: VaultConfigLike;
    kind: VaultRejectKind;
}
/** The outcome of validating a vault registry. */
export interface VaultResolution {
    /** Surviving vaults, paths canonicalized via realpath, input order kept. */
    vaults: VaultConfig[];
    /** Lets a caller decide to provision defaults without creating anything. */
    hasSharedVault: boolean;
    /** Dropped candidates with their machine-readable reasons. */
    rejected: VaultRejection[];
}
/**
 * Builds the plugin-internal directory of a vault root
 * (`<vault>/.obsidian-mem`). The dot-directory rule keeps it and everything
 * below it out of the index; the sidecar metadata lives inside it.
 */
export declare function pluginDir(vaultPath: string): string;
/**
 * Builds the sidecar metadata directory of a vault root
 * (`<vault>/.obsidian-mem/metadata`), holding the indexer state file and the
 * dream diary.
 */
export declare function metadataDir(vaultPath: string): string;
/**
 * IsPluginInternalPath reports whether absPath lies inside the vault's
 * plugin-internal directory, the read/write guards' refusal for
 * `.obsidian-mem/…` targets. Containment is lexical like classifyPath's.
 */
export declare function isPluginInternalPath(vaultPath: string, absPath: string): boolean;
/**
 * Validates and de-dupes candidate vault configs against probe, with zero
 * fs side effects. Candidates must be absolute and exist; mode must be one
 * of the two VaultMode values; duplicates are collapsed by realpath (first
 * occurrence wins). Callers read hasSharedVault to decide whether to run
 * provisionDefaultVault.
 */
export declare function resolveVaults(configs: readonly VaultConfigLike[], probe: FsProbe): VaultResolution;
/**
 * ResolveGlobalFile normalizes one vault's globalFile config: blank,
 * whitespace-only, and omitted all take GLOBAL_MEMORY_FILE_DEFAULT; anything
 * else is trimmed and used verbatim as the vault-root-relative path. This is
 * the layout's one blank-default seam (PLAN-vault-layout "Config model
 * change": "Blank/omitted defaults to GLOBAL.md"); the service config schema
 * calls it too, so the row-config and card-side boundaries default alike.
 * Structural checks (absolute, `..` segments) stay at the row-config schema.
 */
export declare function resolveGlobalFile(value: string | undefined): string;
/**
 * Creates the default shared vault's directory tree under the injected
 * homedir and returns its VaultConfig. Lazy by contract: only the service's
 * ensureMemoryAccess seam calls it, so installs without memory use create no
 * vault. Safe to call again; mkdirp is idempotent.
 */
export declare function provisionDefaultVault(fs: VaultFs, homedir: string): VaultConfig;
/** Returns the first shared vault in list order, or null. Read-only vaults
 * never qualify: .INTENTS.md and plugin writes target shared vaults only. */
export declare function firstSharedVault(vaults: readonly VaultConfig[]): VaultConfig | null;
/** Where an absolute path sits relative to a registered vault. */
export interface ClassifiedPath {
    /** The vault that contains the path. */
    vault: VaultConfig;
    /** The containing vault's access mode, for the write guard. */
    mode: VaultMode;
    /** Whether the path lies in the vault's indexed note tree. */
    insideNotes: boolean;
}
/**
 * Finds the deepest registered vault containing absPath, or null when no
 * vault contains it. Containment is lexical (the registry paths are already
 * canonical from resolveVaults); memory_read/write consult the returned mode
 * before touching the fs.
 */
export declare function classifyPath(vaults: readonly VaultConfig[], absPath: string): ClassifiedPath | null;
/**
 * INTENT_HINTS is the seed line under each `.INTENTS.md` marker. Audit
 * compares section bodies against these lines to tell a recorded intent
 * from seed-only content.
 */
export declare const INTENT_HINTS: Record<IntentMarker, string>;
/**
 * RenderIntentsFile returns the exact seed body of `.INTENTS.md`: one
 * section per intent marker. Audit compares a live file against it to tell
 * seed-only content from recorded intents.
 */
export declare function renderIntentsFile(): string;
/** The result of a .INTENTS.md seed attempt. */
export interface IntentsSeedResult {
    path: string;
    /** False when the file already existed and was left untouched. */
    created: boolean;
}
/**
 * Seeds .INTENTS.md into a vault root, listing the nine intent markers as
 * sections. Idempotent: an existing file is never rewritten, so user edits
 * to the intents survive repeated provisioning passes.
 */
export declare function seedIntentsFile(fs: VaultFs, vaultPath: string): IntentsSeedResult;
//# sourceMappingURL=vaults.d.ts.map
