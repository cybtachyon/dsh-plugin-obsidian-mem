/**
 * The Configuration section: every README Configuration knob the card may
 * edit (the CARD_SETTINGS_KEYS whitelist), mounted directly below Vaults.
 *
 * The body seeds from GET /obsidian-mem/settings (the persisted effective
 * view), every control is a draft input with dirty tracking against that
 * seed, and Apply POSTs one patch: dirty fields go into `set`; a blanked
 * text field that carries a card override goes into `unset`, because the
 * store's clear rule (TASK-002) is deleting the key so the profile row
 * wins again, never writing a sentinel. Blank number fields and a blank
 * non-overridden field send nothing. "Reset all to profile settings" is a
 * two-step confirm (the Vaults remove precedent) that DELETEs every
 * override. A successful apply or reset re-seeds from the fresh view the
 * route already answers and toasts. The card never sees a profile-row value
 * an override masks, so per-field revert to the row IS the unset channel.
 * @module dsh-plugin-obsidian-mem/client/sections/configuration
 */
import type { ReactNode } from 'react';
import { type CardEditablePatch } from '../api.js';
/** The control a knob renders as: width picker, number, text, or off/on. */
export type ConfigFieldKind = 'dim' | 'number' | 'text' | 'toggle';
/** One whitelisted knob: its dot-path, layout placement, and control copy. */
export interface ConfigFieldSpec {
    /** The CARD_SETTINGS_KEYS leaf path (configuration.spec.ts pins the set). */
    path: string;
    group: string;
    label: string;
    kind: ConfigFieldKind;
    /** The one-line hover tooltip. */
    tooltip: string;
    /** The schema default shown as placeholder while the draft is empty. */
    placeholder?: string;
    /** A quiet hint line rendered under the field row. */
    hint?: string;
}
export declare const CONFIG_FIELDS: readonly ConfigFieldSpec[];
/** One knob's diff input: the loaded baseline, the current draft, and its override state. */
export interface ConfigFieldDraft {
    path: string;
    kind: ConfigFieldKind;
    baseline: string;
    draft: string;
    custom: boolean;
}
/** The apply body: nested whitelisted leaves to set plus override paths to drop. */
export interface ConfigSettingsPatch {
    set: CardEditablePatch;
    unset: string[];
}
/**
 * BuildSettingsPatch diffs drafts against the loaded view: a changed field
 * parses into the nested `set` object; a blanked text field that carries an
 * override joins `unset` (the store's clear rule deletes the key so the
 * profile row wins again); a blank number field, a blank field with no
 * override to drop, and an unparsable number send nothing.
 */
export declare function buildSettingsPatch(fields: readonly ConfigFieldDraft[]): ConfigSettingsPatch;
export declare function ConfigurationSection(): ReactNode;
//# sourceMappingURL=configuration.d.ts.map
