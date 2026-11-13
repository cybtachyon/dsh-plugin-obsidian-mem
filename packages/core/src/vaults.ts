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

import { isAbsolute, join, normalize, sep } from 'node:path'
import {
  defaultVaultPath,
  INTENTS_FILE,
  INTENT_MARKERS,
  VAULT_METADATA_DIR,
} from './constants.js'
import type { IntentMarker } from './constants.js'

/** Mode with full access: the plugin indexes and writes into the vault. */
export const VAULT_MODE_SHARED = 'shared'
/** Mode with recall only: the plugin reads and never writes the vault. */
export const VAULT_MODE_READ_ONLY = 'read-only'

/** The two access modes; resolveVaults validation and the type share it. */
export const VAULT_MODES = [VAULT_MODE_SHARED, VAULT_MODE_READ_ONLY] as const

/** One of the two vault access modes. */
export type VaultMode = typeof VAULT_MODES[number]

/** Tests whether value names one of the two vault modes. */
export function isVaultMode(value: string): value is VaultMode {
  return (VAULT_MODES as readonly string[]).includes(value)
}

/** A registered vault: an absolute path plus its access mode. */
export interface VaultConfig {
  path: string
  mode: VaultMode
}

/**
 * FsProbe is the read-only fs surface vault validation needs. The service
 * implements it over node:fs; tests pass an in-memory stub.
 */
export interface FsProbe {
  /** Reports whether the path exists (file or directory). */
  exists(path: string): boolean
  /** Returns the canonical location a path resolves to. */
  realpath(path: string): string
}

/**
 * VaultFs adds the write surface provisioning and seeding need. All paths
 * reaching a seam are already absolute; the seam must not reinterpret them.
 */
export interface VaultFs extends FsProbe {
  /** Creates the directory and any missing parents (mkdir -p semantics). */
  mkdirp(path: string): void
  /** Reads a UTF-8 file, or returns null when it does not exist. */
  readFile(path: string): string | null
  /** Writes the UTF-8 contents, replacing any previous file. */
  writeFile(path: string, contents: string): void
}

/** The wider record resolveVaults validates: mode arrives as user config. */
export interface VaultConfigLike {
  path: string
  mode: string
}

/** Why resolveVaults dropped one candidate config. */
export type VaultRejectKind =
  | 'path-not-absolute'
  | 'path-missing'
  | 'mode-invalid'
  | 'duplicate'

/** One rejected candidate, kept so callers can report every problem. */
export interface VaultRejection {
  config: VaultConfigLike
  kind: VaultRejectKind
}

/** The outcome of validating a vault registry. */
export interface VaultResolution {
  /** Surviving vaults, paths canonicalized via realpath, input order kept. */
  vaults: VaultConfig[]
  /** Lets a caller decide to provision defaults without creating anything. */
  hasSharedVault: boolean
  /** Dropped candidates with their machine-readable reasons. */
  rejected: VaultRejection[]
}

// Transitional value only: the vault root IS the note root in the current
// layout, so nothing new may join on it. markdownDir stays solely so the
// service/tools callers still compile until each task re-points them to the
// vault path; delete this const with the helper.
const LEGACY_MARKDOWN_DIR = 'markdown'

/** Builds the removed-shape note directory of a vault root; do not call for
 * new layout work, the vault root itself is the note root. */
export function markdownDir(vaultPath: string): string {
  return join(vaultPath, LEGACY_MARKDOWN_DIR)
}

/** Builds the sidecar metadata directory of a vault root. */
export function metadataDir(vaultPath: string): string {
  return join(vaultPath, VAULT_METADATA_DIR)
}

/**
 * Validates and de-dupes candidate vault configs against probe, with zero
 * fs side effects. Candidates must be absolute and exist; mode must be one
 * of the two VaultMode values; duplicates are collapsed by realpath (first
 * occurrence wins). Callers read hasSharedVault to decide whether to run
 * provisionDefaultVault.
 */
export function resolveVaults(
  configs: readonly VaultConfigLike[],
  probe: FsProbe,
): VaultResolution {
  const vaults: VaultConfig[] = []
  const rejected: VaultRejection[] = []
  const seen = new Set<string>()

  for (const config of configs) {
    const path = normalize(config.path)
    if (!isAbsolute(path)) {
      rejected.push({ config, kind: 'path-not-absolute' })
      continue
    }
    if (!isVaultMode(config.mode)) {
      rejected.push({ config, kind: 'mode-invalid' })
      continue
    }
    if (!probe.exists(path)) {
      rejected.push({ config, kind: 'path-missing' })
      continue
    }
    const canonical = probe.realpath(path)
    if (seen.has(canonical)) {
      rejected.push({ config, kind: 'duplicate' })
      continue
    }
    seen.add(canonical)
    vaults.push({ path: canonical, mode: config.mode })
  }

  return {
    vaults,
    hasSharedVault: vaults.some((vault) => vault.mode === VAULT_MODE_SHARED),
    rejected,
  }
}

/**
 * Creates the default shared vault's directory tree under the injected
 * homedir and returns its VaultConfig. Lazy by contract: only the service's
 * ensureMemoryAccess seam calls it, so installs without memory use create no
 * vault. Safe to call again; mkdirp is idempotent.
 */
export function provisionDefaultVault(fs: VaultFs, homedir: string): VaultConfig {
  const path = defaultVaultPath(homedir)
  fs.mkdirp(path)
  fs.mkdirp(markdownDir(path))
  fs.mkdirp(metadataDir(path))
  return { path, mode: VAULT_MODE_SHARED }
}

/** Returns the first shared vault in list order, or null. Read-only vaults
 * never qualify: .INTENTS.md and plugin writes target shared vaults only. */
export function firstSharedVault(vaults: readonly VaultConfig[]): VaultConfig | null {
  return vaults.find((vault) => vault.mode === VAULT_MODE_SHARED) ?? null
}

/** Where an absolute path sits relative to a registered vault. */
export interface ClassifiedPath {
  /** The vault that contains the path. */
  vault: VaultConfig
  /** The containing vault's access mode, for the write guard. */
  mode: VaultMode
  /** Whether the path lies under the vault's note directory specifically. */
  insideMarkdownDir: boolean
}

/**
 * Finds the deepest registered vault containing absPath, or null when no
 * vault contains it. Containment is lexical (the registry paths are already
 * canonical from resolveVaults); memory_read/write consult the returned mode
 * before touching the fs.
 */
export function classifyPath(
  vaults: readonly VaultConfig[],
  absPath: string,
): ClassifiedPath | null {
  if (!isAbsolute(absPath)) {
    return null
  }
  const target = normalize(absPath)

  let best: VaultConfig | null = null
  for (const vault of vaults) {
    if (!isWithin(vault.path, target)) {
      continue
    }
    // Deepest match wins so a vault nested inside another claims its own
    // files, keeping mode decisions with the tightest owner.
    if (best === null || vault.path.length > best.path.length) {
      best = vault
    }
  }
  if (best === null) {
    return null
  }

  return {
    vault: best,
    mode: best.mode,
    insideMarkdownDir: isWithin(markdownDir(best.path), target),
  }
}

// Directory-or-equal containment on normalized absolute paths. The trailing
// separator blocks a /a/b prefix from matching an /a/bc sibling, and covers
// a root dir that already ends in one.
function isWithin(dir: string, target: string): boolean {
  if (target === dir) {
    return true
  }
  return target.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * INTENT_HINTS is the seed line under each `.INTENTS.md` marker. Audit
 * compares section bodies against these lines to tell a recorded intent
 * from seed-only content.
 */
export const INTENT_HINTS: Record<IntentMarker, string> = {
  who: 'People, tools, and services a memory involves.',
  what: 'What happened, what was decided, what rule was learned.',
  when: 'Timing, deadlines, and sequence facts worth keeping.',
  where: 'Paths, URLs, hosts, and environments the memory points at.',
  how: 'Procedures and mechanics worth repeating verbatim.',
  why: 'Motivations and constraints behind a decision.',
  investigate: 'Open questions worth digging into later.',
  debug: 'Known failure signatures and their causes.',
  troubleshoot: 'Workarounds and recovery steps that worked.',
}

// One canonical section per intent marker, built from INTENT_MARKERS so the
// file and the constant list can never drift apart.
/**
 * RenderIntentsFile returns the exact seed body of `.INTENTS.md`: one
 * section per intent marker. Audit compares a live file against it to tell
 * seed-only content from recorded intents.
 */
export function renderIntentsFile(): string {
  const header = [
    '# Memory intents',
    '',
    'The recall-intent checklist for this vault. Each memory should serve at',
    'least one marker; audit and the dreaming pass walk these sections.',
    '',
  ]
  const sections = INTENT_MARKERS.map((marker) => [
    `## ${marker}`,
    '',
    INTENT_HINTS[marker],
    '',
  ].join('\n'))
  return `${header.join('\n')}${sections.join('\n')}`
}

/** The result of a .INTENTS.md seed attempt. */
export interface IntentsSeedResult {
  path: string
  /** False when the file already existed and was left untouched. */
  created: boolean
}

/**
 * Seeds .INTENTS.md into a vault root, listing the nine intent markers as
 * sections. Idempotent: an existing file is never rewritten, so user edits
 * to the intents survive repeated provisioning passes.
 */
export function seedIntentsFile(fs: VaultFs, vaultPath: string): IntentsSeedResult {
  const path = join(vaultPath, INTENTS_FILE)
  if (fs.exists(path)) {
    return { path, created: false }
  }
  fs.writeFile(path, renderIntentsFile())
  return { path, created: true }
}
