/**
 * The card-settings domain: the whitelist tree operations behind the
 * settings store (override filtering, the merge over the row config, patch
 * folding, path removal, the effective-view slice, and the changed-path
 * diff). Pure functions only; disk reads, persistence, escalation, and
 * logging stay with ObsidianMemService, and CARD_SETTINGS_KEYS (config.ts)
 * stays the single whitelist source.
 * @module dsh-plugin-obsidian-mem/service/card-settings
 */

import {
  CARD_SETTINGS_KEYS,
  isRecord,
  validateObsidianMemConfig,
} from './config.js'
import type {
  CardEditableConfig,
  ObsidianMemConfigValidation,
  ResolvedObsidianMemConfig,
} from './config.js'

// PickCardSettingsPath walks one dot-path through a stored override tree,
// a card view, or a config. A missing or non-object intermediate answers
// undefined. It is the one path reader behind the merge and the diff.
function pickCardSettingsPath(
  value: CardEditableConfig | ResolvedObsidianMemConfig | Record<string, unknown>,
  key: string,
): unknown {
  let current: unknown = value
  for (const part of key.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * FilterCardSettingsTree keeps only the CARD_SETTINGS_KEYS leaf paths of a
 * patch or stored override tree: whitelist leaves pass through untyped (the
 * merged config is schema-revalidated as a whole), records that prefix a
 * whitelist key recurse, and everything else lands in `rejected` as its
 * dot-path. Validation-only callers (updateCardSettings) pass an
 * accumulator and discard the kept tree; persistence-load callers
 * (readSettingsOverrides) keep the filtered tree and warn naming `rejected`.
 */
export function filterCardSettingsTree(
  value: Record<string, unknown>,
  rejected: string[],
  prefix: readonly string[] = [],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, given] of Object.entries(value)) {
    const path = [...prefix, key].join('.')
    if (CARD_SETTINGS_KEYS.includes(path)) {
      kept[key] = given
      continue
    }
    if (isRecord(given) && CARD_SETTINGS_KEYS.some((leaf) => leaf.startsWith(`${path}.`))) {
      const nested = filterCardSettingsTree(given, rejected, [...prefix, key])
      if (Object.keys(nested).length > 0) kept[key] = nested
      continue
    }
    rejected.push(path)
  }
  return kept
}

/**
 * MergeCardSettingsOverrides writes each present whitelist path onto a
 * structural copy of the resolved row config, so a partial override keeps
 * every sibling the row already set (an override of budgets.searchTopK
 * alone leaves the row's other budgets in place).
 */
export function mergeCardSettingsOverrides(
  resolved: ResolvedObsidianMemConfig,
  overrides: Record<string, unknown>,
): ResolvedObsidianMemConfig {
  const merged: ResolvedObsidianMemConfig = {
    ...resolved,
    vaults: resolved.vaults.map((vault) => ({ ...vault })),
    model: { ...resolved.model },
    milvus: { ...resolved.milvus },
    budgets: { ...resolved.budgets },
    llm: { ...resolved.llm },
    dreaming: {
      ...resolved.dreaming,
      schedules: resolved.dreaming.schedules.map((schedule) => ({ ...schedule })),
    },
  }
  for (const key of CARD_SETTINGS_KEYS) {
    const given = pickCardSettingsPath(overrides, key)
    if (given === undefined) continue
    const parts = key.split('.')
    let target = merged as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      target = target[part] as Record<string, unknown>
    }
    target[parts[parts.length - 1]!] = given
  }
  return merged
}

/**
 * ValidateMergedCardSettings merges an override tree over a resolved config
 * and revalidates the draft through the full config schema: the one
 * merge+validate expression the boot merge, the apply-time draft gate, and
 * the effective view share. A rejected draft answers its issues; the caller
 * owns the fallback and its warn wording.
 */
export function validateMergedCardSettings(
  base: ResolvedObsidianMemConfig,
  overrides: Record<string, unknown>,
): ObsidianMemConfigValidation {
  return validateObsidianMemConfig(mergeCardSettingsOverrides(base, overrides))
}

/**
 * MergeCardSettingsPatch folds a path-validated patch into the stored
 * overrides tree: groups merge key-wise so a partial group keeps its
 * stored siblings, leaves overwrite.
 */
export function mergeCardSettingsPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, given] of Object.entries(patch)) {
    if (isRecord(given)) {
      const existing = target[key]
      const nested = isRecord(existing) ? existing : {}
      mergeCardSettingsPatch(nested, given)
      target[key] = nested
      continue
    }
    target[key] = given
  }
}

/**
 * RemoveCardSettingsPath deletes one whitelist dot-path from the stored
 * overrides tree and prunes the group the deletion emptied, so the file
 * records only real edits. A missing intermediate is already the unset
 * answer.
 */
export function removeCardSettingsPath(tree: Record<string, unknown>, path: string): void {
  const [head, ...rest] = path.split('.')
  if (rest.length === 0) {
    delete tree[head!]
    return
  }
  const nested = tree[head!]
  if (!isRecord(nested)) return
  removeCardSettingsPath(nested, rest.join('.'))
  if (Object.keys(nested).length === 0) delete tree[head!]
}

/**
 * CardEditableSlice copies the card-editable group fields out of a
 * (resolved) config so the view never aliases the running config object.
 */
export function cardEditableSlice(config: ResolvedObsidianMemConfig): CardEditableConfig {
  return {
    vectorDim: config.vectorDim,
    model: { id: config.model.id, cacheDir: config.model.cacheDir },
    milvus: { dbPath: config.milvus.dbPath },
    budgets: { ...config.budgets },
    llm: { ...config.llm },
  }
}

/**
 * DifferingCardSettingsPaths answers the whitelisted dot-paths where two
 * card views differ: the before/after diff of an apply and the
 * persisted-vs-running restartPending diff. Every card-editable leaf is a
 * scalar, so strict inequality IS the deep diff.
 */
export function differingCardSettingsPaths(
  left: CardEditableConfig | ResolvedObsidianMemConfig,
  right: CardEditableConfig | ResolvedObsidianMemConfig,
): string[] {
  return CARD_SETTINGS_KEYS.filter(
    (key) => pickCardSettingsPath(left, key) !== pickCardSettingsPath(right, key),
  )
}
