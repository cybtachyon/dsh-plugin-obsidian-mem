/**
 * The card-settings domain: the whitelist tree operations behind the
 * settings store (override filtering, the merge over the row config, patch
 * folding, path removal, the effective-view slice, and the changed-path
 * diff). Pure functions only; disk reads, persistence, escalation, and
 * logging stay with ObsidianMemService, and CARD_SETTINGS_KEYS (config.ts)
 * stays the single whitelist source.
 * @module dsh-plugin-obsidian-mem/service/card-settings
 */
import type { CardEditableConfig, ObsidianMemConfigValidation, ResolvedObsidianMemConfig } from './config.js';
/**
 * FilterCardSettingsTree keeps only the CARD_SETTINGS_KEYS leaf paths of a
 * patch or stored override tree: whitelist leaves pass through untyped (the
 * merged config is schema-revalidated as a whole), records that prefix a
 * whitelist key recurse, and everything else lands in `rejected` as its
 * dot-path. Validation-only callers (updateCardSettings) pass an
 * accumulator and discard the kept tree; persistence-load callers
 * (readSettingsOverrides) keep the filtered tree and warn naming `rejected`.
 */
export declare function filterCardSettingsTree(value: Record<string, unknown>, rejected: string[], prefix?: readonly string[]): Record<string, unknown>;
/**
 * MergeCardSettingsOverrides writes each present whitelist path onto a
 * structural copy of the resolved row config, so a partial override keeps
 * every sibling the row already set (an override of budgets.searchTopK
 * alone leaves the row's other budgets in place).
 */
export declare function mergeCardSettingsOverrides(resolved: ResolvedObsidianMemConfig, overrides: Record<string, unknown>): ResolvedObsidianMemConfig;
/**
 * ValidateMergedCardSettings merges an override tree over a resolved config
 * and revalidates the draft through the full config schema: the one
 * merge+validate expression the boot merge, the apply-time draft gate, and
 * the effective view share. A rejected draft answers its issues; the caller
 * owns the fallback and its warn wording.
 */
export declare function validateMergedCardSettings(base: ResolvedObsidianMemConfig, overrides: Record<string, unknown>): ObsidianMemConfigValidation;
/**
 * MergeCardSettingsPatch folds a path-validated patch into the stored
 * overrides tree: groups merge key-wise so a partial group keeps its
 * stored siblings, leaves overwrite.
 */
export declare function mergeCardSettingsPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void;
/**
 * RemoveCardSettingsPath deletes one whitelist dot-path from the stored
 * overrides tree and prunes the group the deletion emptied, so the file
 * records only real edits. A missing intermediate is already the unset
 * answer.
 */
export declare function removeCardSettingsPath(tree: Record<string, unknown>, path: string): void;
/**
 * CardEditableSlice copies the card-editable group fields out of a
 * (resolved) config so the view never aliases the running config object.
 */
export declare function cardEditableSlice(config: ResolvedObsidianMemConfig): CardEditableConfig;
/**
 * DifferingCardSettingsPaths answers the whitelisted dot-paths where two
 * card views differ: the before/after diff of an apply and the
 * persisted-vs-running restartPending diff. Every card-editable leaf is a
 * scalar, so strict inequality IS the deep diff.
 */
export declare function differingCardSettingsPaths(left: CardEditableConfig | ResolvedObsidianMemConfig, right: CardEditableConfig | ResolvedObsidianMemConfig): string[];
//# sourceMappingURL=card-settings.d.ts.map
