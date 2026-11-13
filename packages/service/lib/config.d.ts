/**
 * The obsidianMem plugin Config: one Standard-Schema (cordis `Config` slot)
 * whose resolved values are the defaults, so a mounted `{}` is a complete
 * config, plus {@link resolveServiceConfig}, the only place `~` expands and
 * relative paths become absolute.
 *
 * The schema is hand-rolled (no zod/schemastery dependency, and core keeps
 * its "no gray-matter-style deps" reach): unknown keys never throw. They are
 * collected onto the resolved value under {@link UNKNOWN_CONFIG_KEYS} so the
 * service can warn once through the plugin logger (warn-don't-die), and they
 * never reach the resolved config the plugin runs on. Wrong types and
 * out-of-enum values DO fail validation: cordis then fails the fiber loudly
 * instead of the plugin silently running on garbage.
 * @module dsh-plugin-obsidian-mem/service/config
 */
import type { Plugin } from '@deepseek-ai/cordis';
import type { VaultConfig } from '../../core/lib/index.js';
/** G13: cold uvx on an empty cache can exceed 400 s (1.3 GB wheels). */
export declare const DEFAULT_READINESS_TIMEOUT_MS = 600000;
/** One card-managed dreaming trigger row (mirrors the DSH schedule shapes). */
export interface DreamingSchedule {
    id: string;
    label: string;
    /** cron expression; XOR everySeconds. */
    expression?: string;
    /** fixed interval seconds; XOR expression. */
    everySeconds?: number;
}
/**
 * MountedVaultEntry is one `vaults` row as it arrives in config: mode
 * defaults to shared and globalFile to the layout default during validation.
 */
export interface MountedVaultEntry {
    path: string;
    mode?: string;
    globalFile?: string;
}
/**
 * ResolvedVaultEntry is one validated `vaults` row: mode and globalFile are
 * present, paths still raw. After resolveServiceConfig absolutizes the path
 * the entry is a core VaultConfig.
 */
export interface ResolvedVaultEntry {
    path: string;
    mode: string;
    globalFile: string;
}
/** Mounted (pre-default) config shape: every field optional. */
export interface ObsidianMemConfig {
    vaults?: MountedVaultEntry[];
    vectorDim?: number;
    model?: {
        id?: string;
        dtype?: string;
    };
    milvus?: {
        mode?: string;
        address?: string;
        dbPath?: string;
        readinessTimeoutMs?: number;
    };
    budgets?: {
        turnStartRecallTokens?: number;
        globalMemoryTokens?: number;
        readSections?: number;
        readSectionTokens?: number;
        searchTopK?: number;
        thinkShotsPerTurn?: number;
    };
    llm?: {
        enabled?: boolean;
        baseUrl?: string;
        model?: string;
        apiKeyEnv?: string;
    };
    dreaming?: {
        schedules?: DreamingSchedule[];
        /** Dream agent model override; '' uses the session default model. */
        model?: string;
        /** Pairwise cosine at or above which notes join a merge cluster. */
        nearDuplicateThreshold?: number;
    };
}
/** The fully defaulted config the service runs on (paths still raw). */
export interface ObsidianMemResolvedConfig {
    /** globalFile is resolved: blank or omitted takes GLOBAL_MEMORY_FILE_DEFAULT via core resolveGlobalFile. */
    vaults: ResolvedVaultEntry[];
    vectorDim: number;
    model: {
        id: string;
        dtype: string;
    };
    milvus: {
        mode: 'spawn' | 'external';
        address: string;
        dbPath: string;
        readinessTimeoutMs: number;
    };
    budgets: {
        turnStartRecallTokens: number;
        globalMemoryTokens: number;
        readSections: number;
        readSectionTokens: number;
        searchTopK: number;
        thinkShotsPerTurn: number;
    };
    llm: {
        enabled: boolean;
        baseUrl: string;
        model: string;
        apiKeyEnv: string;
    };
    dreaming: {
        schedules: DreamingSchedule[];
        model: string;
        nearDuplicateThreshold: number;
    };
}
/** The config after path resolution: vault paths and dbPath are absolute. */
export interface ResolvedObsidianMemConfig extends ObsidianMemResolvedConfig {
    /** Mode narrowed by schema validation (VAULT_MODES membership); entries are core VaultConfigs. */
    vaults: VaultConfig[];
}
/**
 * UNKNOWN_CONFIG_KEYS carries the dot-joined paths of unknown config keys
 * the schema collected during validation (non-enumerable symbol property on
 * the resolved value). The service logs them once; nothing else reads them.
 */
export declare const UNKNOWN_CONFIG_KEYS: unique symbol;
/** The plugin `Config` slot shape cordis validates the mounted row config against. */
type ConfigSchema = NonNullable<Plugin.Base<ResolvedObsidianMemConfig>['Config']>;
/** One validation issue: a message plus its config path. */
export interface ConfigIssue {
    message: string;
    path: (string | number)[];
}
/** The synchronous validation result of {@link validateObsidianMemConfig}. */
export type ObsidianMemConfigValidation = {
    value: ResolvedObsidianMemConfig;
    issues: undefined;
} | {
    issues: readonly ConfigIssue[];
};
/** ObsidianMemConfigSchema validates a mounted row config and defaults it whole. */
export declare const ObsidianMemConfigSchema: ConfigSchema;
/**
 * GlobalFileShapeIssue returns the validation phrase for why a resolved
 * (already defaulted) globalFile is not a vault-root-relative path, or null
 * when it is fine. The row-config schema and the service's addVault share it
 * so the structural rule (no leading `/`, no `..` segment) has one
 * definition; the blank default itself lives in core resolveGlobalFile.
 */
export declare function globalFileShapeIssue(resolved: string): string | null;
/**
 * ResolveServiceConfig expands `~`, absolutizes every vault path against the
 * home, and fills the dbPath default from core dbDir. It is the only place
 * $HOME enters the config (mirrors core's homedir-argument discipline).
 */
export declare function resolveServiceConfig(config: ObsidianMemResolvedConfig, homedir: string): ResolvedObsidianMemConfig;
/**
 * ExpandHomePath turns a leading `~` into home and resolves a relative path
 * against it; absolute paths pass through unchanged.
 */
export declare function expandHomePath(path: string, home: string): string;
/** VaultKey is the vault identity stored in the Milvus `vault` column. */
export declare function vaultKey(path: string): string;
/**
 * ValidateObsidianMemConfig is the schema's synchronous validator, exported
 * so the service class can re-validate a hand-passed config object the same
 * way cordis validated the mounted row (idempotent on already-resolved
 * values, and it carries the unknown-key list onto the result).
 */
export declare function validateObsidianMemConfig(value: unknown): ObsidianMemConfigValidation;
export {};
//# sourceMappingURL=config.d.ts.map
