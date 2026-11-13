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
import { isAbsolute, join, resolve } from 'node:path';
import { dbDir, DEFAULT_MODEL_ID, DREAM_NEAR_DUPLICATE_THRESHOLD, GLOBAL_MEMORY_TOKENS, isVectorDim, MILVUS_SCALAR_MAX_LENGTHS, RECALL_READ_MAX_SECTIONS, RECALL_READ_SECTION_TOKENS, RECALL_TURN_START_TOKENS, SEARCH_DEFAULT_TOP_K, TRANSFORMERS_PIPELINE_OPTIONS, VAULT_MODES, VECTOR_DIM_DEFAULT, VECTOR_DIM_LOSSY, } from '../../core/lib/index.js';
/** G13: cold uvx on an empty cache can exceed 400 s (1.3 GB wheels). */
export const DEFAULT_READINESS_TIMEOUT_MS = 600_000;
/**
 * UNKNOWN_CONFIG_KEYS carries the dot-joined paths of unknown config keys
 * the schema collected during validation (non-enumerable symbol property on
 * the resolved value). The service logs them once; nothing else reads them.
 */
export const UNKNOWN_CONFIG_KEYS = Symbol('obsidian-mem.unknownConfigKeys');
const TOP_KEYS = ['vaults', 'vectorDim', 'model', 'milvus', 'budgets', 'llm', 'dreaming'];
// The default budgets table (core constants are the single source;
// thinkShotsPerTurn has no core constant: TASK-043 is its consumer).
const DEFAULT_BUDGETS = {
    turnStartRecallTokens: RECALL_TURN_START_TOKENS,
    globalMemoryTokens: GLOBAL_MEMORY_TOKENS,
    readSections: RECALL_READ_MAX_SECTIONS,
    readSectionTokens: RECALL_READ_SECTION_TOKENS,
    searchTopK: SEARCH_DEFAULT_TOP_K,
    thinkShotsPerTurn: 3,
};
function defaults() {
    return {
        vaults: [],
        vectorDim: VECTOR_DIM_DEFAULT,
        model: { id: DEFAULT_MODEL_ID, dtype: TRANSFORMERS_PIPELINE_OPTIONS.dtype },
        milvus: {
            mode: 'spawn',
            address: '',
            // '' = "core dbDir(homedir)" decided at resolveServiceConfig time,
            // the only place $HOME enters (keeps core env-free).
            dbPath: '',
            readinessTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
        },
        budgets: { ...DEFAULT_BUDGETS },
        llm: { enabled: false, baseUrl: '', model: '', apiKeyEnv: '' },
        dreaming: { schedules: [], model: '', nearDuplicateThreshold: DREAM_NEAR_DUPLICATE_THRESHOLD },
    };
}
/** ObsidianMemConfigSchema validates a mounted row config and defaults it whole. */
export const ObsidianMemConfigSchema = {
    '~standard': {
        version: 1,
        vendor: 'obsidian-mem',
        validate: validateConfig,
    },
};
function validateConfig(value) {
    const issues = [];
    const unknownKeys = [];
    const resolved = defaults();
    if (value === undefined || value === null) {
        return succeed(resolved, unknownKeys);
    }
    if (!isObject(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
    }
    collectUnknown(value, [], TOP_KEYS, unknownKeys);
    if (value.vaults !== undefined) {
        if (!Array.isArray(value.vaults)) {
            issues.push({ message: 'vaults must be an array', path: ['vaults'] });
        }
        else {
            const vaults = [];
            value.vaults.forEach((entry, index) => {
                if (!isObject(entry)) {
                    issues.push({ message: 'vault entry must be an object', path: ['vaults', index] });
                    return;
                }
                collectUnknown(entry, ['vaults', index], ['path', 'mode'], unknownKeys);
                if (typeof entry.path !== 'string' || entry.path.trim() === '') {
                    issues.push({ message: 'vault path must be a non-empty string', path: ['vaults', index, 'path'] });
                    return;
                }
                const mode = entry.mode === undefined ? 'shared' : entry.mode;
                if (typeof mode !== 'string' || !VAULT_MODES.includes(mode)) {
                    issues.push({
                        message: `vault mode must be one of ${VAULT_MODES.join(' | ')}, got ${JSON.stringify(entry.mode)}`,
                        path: ['vaults', index, 'mode'],
                    });
                    return;
                }
                vaults.push({ path: entry.path, mode });
            });
            resolved.vaults = vaults;
        }
    }
    if (value.vectorDim !== undefined) {
        if (typeof value.vectorDim === 'number' && isVectorDim(value.vectorDim)) {
            resolved.vectorDim = value.vectorDim;
        }
        else {
            issues.push({
                message: `vectorDim must be ${String(VECTOR_DIM_DEFAULT)} (full width) or one of ${VECTOR_DIM_LOSSY.join('/')} `
                    + '(LOSSY truncation, forces a full re-index)',
                path: ['vectorDim'],
            });
        }
    }
    if (value.model !== undefined) {
        if (!isObject(value.model)) {
            issues.push({ message: 'model must be an object', path: ['model'] });
        }
        else {
            collectUnknown(value.model, ['model'], ['id', 'dtype'], unknownKeys);
            const model = value.model;
            const stringField = (key, path) => {
                const given = model[key];
                if (given === undefined)
                    return resolved.model[key];
                if (typeof given === 'string' && given.trim() !== '')
                    return given;
                issues.push({ message: `model.${key} must be a non-empty string`, path });
                return resolved.model[key];
            };
            resolved.model = {
                id: stringField('id', ['model', 'id']),
                dtype: stringField('dtype', ['model', 'dtype']),
            };
        }
    }
    if (value.milvus !== undefined) {
        if (!isObject(value.milvus)) {
            issues.push({ message: 'milvus must be an object', path: ['milvus'] });
        }
        else {
            collectUnknown(value.milvus, ['milvus'], ['mode', 'address', 'dbPath', 'readinessTimeoutMs'], unknownKeys);
            const mode = value.milvus.mode === undefined ? 'spawn' : value.milvus.mode;
            if (mode !== 'spawn' && mode !== 'external') {
                issues.push({ message: 'milvus.mode must be spawn or external', path: ['milvus', 'mode'] });
            }
            const timeout = positiveNumber(value.milvus.readinessTimeoutMs);
            if (value.milvus.readinessTimeoutMs !== undefined && timeout === null) {
                issues.push({
                    message: 'milvus.readinessTimeoutMs must be a positive number of ms',
                    path: ['milvus', 'readinessTimeoutMs'],
                });
            }
            resolved.milvus = {
                mode: mode === 'external' ? 'external' : 'spawn',
                address: stringOr(value.milvus.address, resolved.milvus.address, 'milvus.address', ['milvus', 'address'], issues),
                dbPath: stringOr(value.milvus.dbPath, resolved.milvus.dbPath, 'milvus.dbPath', ['milvus', 'dbPath'], issues),
                readinessTimeoutMs: timeout ?? resolved.milvus.readinessTimeoutMs,
            };
        }
    }
    if (value.budgets !== undefined) {
        if (!isObject(value.budgets)) {
            issues.push({ message: 'budgets must be an object', path: ['budgets'] });
        }
        else {
            const keys = Object.keys(DEFAULT_BUDGETS);
            collectUnknown(value.budgets, ['budgets'], keys, unknownKeys);
            for (const key of keys) {
                const given = value.budgets[key];
                if (given === undefined)
                    continue;
                const parsed = positiveNumber(given);
                if (parsed === null) {
                    issues.push({ message: `budgets.${key} must be a positive number`, path: ['budgets', key] });
                }
                else {
                    ;
                    resolved.budgets[key] = Math.trunc(parsed);
                }
            }
        }
    }
    if (value.llm !== undefined) {
        if (!isObject(value.llm)) {
            issues.push({ message: 'llm must be an object', path: ['llm'] });
        }
        else {
            collectUnknown(value.llm, ['llm'], ['enabled', 'baseUrl', 'model', 'apiKeyEnv'], unknownKeys);
            const enabled = value.llm.enabled === undefined ? false : value.llm.enabled;
            if (typeof enabled !== 'boolean') {
                issues.push({ message: 'llm.enabled must be a boolean', path: ['llm', 'enabled'] });
            }
            resolved.llm = {
                enabled: typeof enabled === 'boolean' ? enabled : false,
                baseUrl: stringOr(value.llm.baseUrl, '', 'llm.baseUrl', ['llm', 'baseUrl'], issues),
                model: stringOr(value.llm.model, '', 'llm.model', ['llm', 'model'], issues),
                apiKeyEnv: stringOr(value.llm.apiKeyEnv, '', 'llm.apiKeyEnv', ['llm', 'apiKeyEnv'], issues),
            };
        }
    }
    if (value.dreaming !== undefined) {
        if (!isObject(value.dreaming)) {
            issues.push({ message: 'dreaming must be an object', path: ['dreaming'] });
        }
        else {
            collectUnknown(value.dreaming, ['dreaming'], ['schedules', 'model', 'nearDuplicateThreshold'], unknownKeys);
            const threshold = value.dreaming.nearDuplicateThreshold;
            if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
                issues.push({ message: 'dreaming.nearDuplicateThreshold must be a number in (0, 1]', path: ['dreaming', 'nearDuplicateThreshold'] });
            }
            resolved.dreaming = {
                schedules: validateSchedules(value.dreaming.schedules, issues),
                model: stringOr(value.dreaming.model, '', 'dreaming.model', ['dreaming', 'model'], issues),
                nearDuplicateThreshold: typeof threshold === 'number' ? threshold : resolved.dreaming.nearDuplicateThreshold,
            };
        }
    }
    if (issues.length > 0) {
        return { issues };
    }
    return succeed(resolved, unknownKeys);
}
function validateSchedules(given, issues) {
    if (given === undefined)
        return [];
    if (!Array.isArray(given)) {
        issues.push({ message: 'dreaming.schedules must be an array', path: ['dreaming', 'schedules'] });
        return [];
    }
    const schedules = [];
    given.forEach((entry, index) => {
        const path = ['dreaming', 'schedules', index];
        if (!isObject(entry)) {
            issues.push({ message: 'schedule entry must be an object', path });
            return;
        }
        if (typeof entry.id !== 'string' || entry.id.trim() === '') {
            issues.push({ message: 'schedule id must be a non-empty string', path: [...path, 'id'] });
            return;
        }
        if (typeof entry.label !== 'string') {
            issues.push({ message: 'schedule label must be a string', path: [...path, 'label'] });
            return;
        }
        const hasExpression = entry.expression !== undefined;
        const hasEvery = entry.everySeconds !== undefined;
        const every = positiveNumber(entry.everySeconds);
        if (hasExpression === hasEvery) {
            issues.push({
                message: 'schedule takes exactly one of expression or everySeconds',
                path,
            });
            return;
        }
        if (hasExpression && typeof entry.expression !== 'string') {
            issues.push({ message: 'schedule expression must be a string', path: [...path, 'expression'] });
            return;
        }
        if (hasEvery && every === null) {
            issues.push({ message: 'schedule everySeconds must be a positive number', path: [...path, 'everySeconds'] });
            return;
        }
        schedules.push({
            id: entry.id,
            label: entry.label,
            ...(hasExpression ? { expression: entry.expression } : {}),
            ...(hasEvery ? { everySeconds: every } : {}),
        });
    });
    return schedules;
}
/**
 * ResolveServiceConfig expands `~`, absolutizes every vault path against the
 * home, and fills the dbPath default from core dbDir. It is the only place
 * $HOME enters the config (mirrors core's homedir-argument discipline).
 */
export function resolveServiceConfig(config, homedir) {
    return {
        ...config,
        vaults: config.vaults.map((vault) => ({
            path: expandHome(vault.path, homedir),
            mode: vault.mode,
        })),
        milvus: {
            ...config.milvus,
            dbPath: config.milvus.dbPath === ''
                ? dbDir(homedir)
                : expandHome(config.milvus.dbPath, homedir),
        },
    };
}
/**
 * ExpandHomePath turns a leading `~` into home and resolves a relative path
 * against it; absolute paths pass through unchanged.
 */
export function expandHomePath(path, home) {
    return expandHome(path, home);
}
/** ExpandHome turns a leading `~` into home and resolves relative paths against it. */
function expandHome(path, home) {
    if (path === '~')
        return home;
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(home, path.slice(2));
    return isAbsolute(path) ? path : resolve(home, path);
}
/** VaultKey is the vault identity stored in the Milvus `vault` column. */
export function vaultKey(path) {
    return path.slice(0, MILVUS_SCALAR_MAX_LENGTHS.vault);
}
/**
 * ValidateObsidianMemConfig is the schema's synchronous validator, exported
 * so the service class can re-validate a hand-passed config object the same
 * way cordis validated the mounted row (idempotent on already-resolved
 * values, and it carries the unknown-key list onto the result).
 */
export function validateObsidianMemConfig(value) {
    return validateConfig(value);
}
function succeed(value, unknownKeys) {
    if (unknownKeys.length > 0) {
        Object.defineProperty(value, UNKNOWN_CONFIG_KEYS, { value: unknownKeys, enumerable: false });
    }
    return { value: value, issues: undefined };
}
function collectUnknown(value, prefix, known, out) {
    for (const key of Object.keys(value)) {
        if (!known.includes(key))
            out.push([...prefix, key].join('.'));
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function stringOr(given, fallback, _name, path, issues) {
    if (given === undefined)
        return fallback;
    if (typeof given === 'string')
        return given;
    issues.push({ message: `${String(path[0])}.${String(path[1])} must be a string`, path });
    return fallback;
}
//# sourceMappingURL=config.js.map
