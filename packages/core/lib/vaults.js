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
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { defaultVaultPath, GLOBAL_MEMORY_FILE_DEFAULT, INTENTS_FILE, INTENT_MARKERS, isReservedNonIndexed, PLUGIN_VAULT_DIR, VAULT_METADATA_DIR, } from './constants.js';
/** Mode with full access: the plugin indexes and writes into the vault. */
export const VAULT_MODE_SHARED = 'shared';
/** Mode with recall only: the plugin reads and never writes the vault. */
export const VAULT_MODE_READ_ONLY = 'read-only';
/** The two access modes; resolveVaults validation and the type share it. */
export const VAULT_MODES = [VAULT_MODE_SHARED, VAULT_MODE_READ_ONLY];
/** Tests whether value names one of the two vault modes. */
export function isVaultMode(value) {
    return VAULT_MODES.includes(value);
}
/**
 * Builds the plugin-internal directory of a vault root
 * (`<vault>/.obsidian-mem`). The dot-directory rule keeps it and everything
 * below it out of the index; the sidecar metadata lives inside it.
 */
export function pluginDir(vaultPath) {
    return join(vaultPath, PLUGIN_VAULT_DIR);
}
/**
 * Builds the sidecar metadata directory of a vault root
 * (`<vault>/.obsidian-mem/metadata`), holding the indexer state file and the
 * dream diary.
 */
export function metadataDir(vaultPath) {
    return join(pluginDir(vaultPath), VAULT_METADATA_DIR);
}
/**
 * IsPluginInternalPath reports whether absPath lies inside the vault's
 * plugin-internal directory, the read/write guards' refusal for
 * `.obsidian-mem/…` targets. Containment is lexical like classifyPath's.
 */
export function isPluginInternalPath(vaultPath, absPath) {
    return isWithin(pluginDir(vaultPath), normalize(absPath));
}
/**
 * Validates and de-dupes candidate vault configs against probe, with zero
 * fs side effects. Candidates must be absolute and exist; mode must be one
 * of the two VaultMode values; duplicates are collapsed by realpath (first
 * occurrence wins). Callers read hasSharedVault to decide whether to run
 * provisionDefaultVault.
 */
export function resolveVaults(configs, probe) {
    const vaults = [];
    const rejected = [];
    const seen = new Set();
    for (const config of configs) {
        const path = normalize(config.path);
        if (!isAbsolute(path)) {
            rejected.push({ config, kind: 'path-not-absolute' });
            continue;
        }
        if (!isVaultMode(config.mode)) {
            rejected.push({ config, kind: 'mode-invalid' });
            continue;
        }
        if (!probe.exists(path)) {
            rejected.push({ config, kind: 'path-missing' });
            continue;
        }
        const canonical = probe.realpath(path);
        if (seen.has(canonical)) {
            rejected.push({ config, kind: 'duplicate' });
            continue;
        }
        seen.add(canonical);
        vaults.push({
            path: canonical,
            mode: config.mode,
            globalFile: resolveGlobalFile(config.globalFile),
        });
    }
    return {
        vaults,
        hasSharedVault: vaults.some((vault) => vault.mode === VAULT_MODE_SHARED),
        rejected,
    };
}
/**
 * ResolveGlobalFile normalizes one vault's globalFile config: blank,
 * whitespace-only, and omitted all take GLOBAL_MEMORY_FILE_DEFAULT; anything
 * else is trimmed and used verbatim as the vault-root-relative path. This is
 * the layout's one blank-default seam (PLAN-vault-layout "Config model
 * change": "Blank/omitted defaults to GLOBAL.md"); the service config schema
 * calls it too, so the row-config and card-side boundaries default alike.
 * Structural checks (absolute, `..` segments) stay at the row-config schema.
 */
export function resolveGlobalFile(value) {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? GLOBAL_MEMORY_FILE_DEFAULT : trimmed;
}
/**
 * GlobalFilePath answers one vault's absolute global memory file target,
 * `<vault path>/<globalFile>`, or null when the joined path lands outside
 * the vault root. This is the ONE joined-path definition (PLAN-vault-layout
 * "Config model change"): session-start injection (TASK-014) reads it, and
 * the dreaming pass (TASK-015) protects exactly this path from compaction.
 * The escape check is the belt that hand-edited registries meet; config
 * validation already refuses absolute and `..` forms.
 */
export function globalFilePath(vault) {
    const path = join(vault.path, vault.globalFile);
    const rel = relative(vault.path, path);
    if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        return null;
    }
    return path;
}
/**
 * Creates the default shared vault's directory tree under the injected
 * homedir and returns its VaultConfig. Lazy by contract: only the service's
 * ensureMemoryAccess seam calls it, so installs without memory use create no
 * vault. Safe to call again; mkdirp is idempotent.
 */
export function provisionDefaultVault(fs, homedir) {
    const path = defaultVaultPath(homedir);
    fs.mkdirp(path);
    fs.mkdirp(metadataDir(path));
    return { path, mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT };
}
/** Returns the first shared vault in list order, or null. Read-only vaults
 * never qualify: .INTENTS.md and plugin writes target shared vaults only. */
export function firstSharedVault(vaults) {
    return vaults.find((vault) => vault.mode === VAULT_MODE_SHARED) ?? null;
}
/**
 * Finds the deepest registered vault containing absPath, or null when no
 * vault contains it. Containment is lexical (the registry paths are already
 * canonical from resolveVaults); memory_read/write consult the returned mode
 * before touching the fs.
 */
export function classifyPath(vaults, absPath) {
    if (!isAbsolute(absPath)) {
        return null;
    }
    const target = normalize(absPath);
    let best = null;
    for (const vault of vaults) {
        if (!isWithin(vault.path, target)) {
            continue;
        }
        // Deepest match wins so a vault nested inside another claims its own
        // files, keeping mode decisions with the tightest owner.
        if (best === null || vault.path.length > best.path.length) {
            best = vault;
        }
    }
    if (best === null) {
        return null;
    }
    return {
        vault: best,
        mode: best.mode,
        insideNotes: isNotesPath(best.path, target),
    };
}
// Note-tree containment for classifyPath: inside the vault root (the root IS
// the note root), outside every dot directory and dot file (that covers
// `.obsidian-mem/…`, `.obsidian/…`, and `.INTENTS.md`), and never a reserved
// protocol file (.INTENTS.md, DREAMS.md, <slug>_history.md).
function isNotesPath(vaultPath, target) {
    if (!isWithin(vaultPath, target) || target === vaultPath) {
        return false;
    }
    const parts = relative(vaultPath, target).split(sep);
    if (parts.some((part) => part.startsWith('.'))) {
        return false;
    }
    return !isReservedNonIndexed(parts[parts.length - 1] ?? '');
}
// Directory-or-equal containment on normalized absolute paths. The trailing
// separator blocks a /a/b prefix from matching an /a/bc sibling, and covers
// a root dir that already ends in one.
function isWithin(dir, target) {
    if (target === dir) {
        return true;
    }
    return target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
/**
 * INTENT_HINTS is the seed line under each `.INTENTS.md` marker. Audit
 * compares section bodies against these lines to tell a recorded intent
 * from seed-only content.
 */
export const INTENT_HINTS = {
    who: 'People, tools, and services a memory involves.',
    what: 'What happened, what was decided, what rule was learned.',
    when: 'Timing, deadlines, and sequence facts worth keeping.',
    where: 'Paths, URLs, hosts, and environments the memory points at.',
    how: 'Procedures and mechanics worth repeating verbatim.',
    why: 'Motivations and constraints behind a decision.',
    investigate: 'Open questions worth digging into later.',
    debug: 'Known failure signatures and their causes.',
    troubleshoot: 'Workarounds and recovery steps that worked.',
};
// One canonical section per intent marker, built from INTENT_MARKERS so the
// file and the constant list can never drift apart.
/**
 * RenderIntentsFile returns the exact seed body of `.INTENTS.md`: one
 * section per intent marker. Audit compares a live file against it to tell
 * seed-only content from recorded intents.
 */
export function renderIntentsFile() {
    const header = [
        '# Memory intents',
        '',
        'The recall-intent checklist for this vault. Each memory should serve at',
        'least one marker; audit and the dreaming pass walk these sections.',
        '',
    ];
    const sections = INTENT_MARKERS.map((marker) => [
        `## ${marker}`,
        '',
        INTENT_HINTS[marker],
        '',
    ].join('\n'));
    return `${header.join('\n')}${sections.join('\n')}`;
}
/**
 * Seeds .INTENTS.md into a vault root, listing the nine intent markers as
 * sections. Idempotent: an existing file is never rewritten, so user edits
 * to the intents survive repeated provisioning passes.
 */
export function seedIntentsFile(fs, vaultPath) {
    const path = join(vaultPath, INTENTS_FILE);
    if (fs.exists(path)) {
        return { path, created: false };
    }
    fs.writeFile(path, renderIntentsFile());
    return { path, created: true };
}
//# sourceMappingURL=vaults.js.map
