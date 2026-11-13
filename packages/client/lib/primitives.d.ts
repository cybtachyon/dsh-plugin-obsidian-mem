/**
 * The guarded primitive renderers: every control the card draws resolves the
 * shell's @deepseek-ai/dsh-client-ui-primitives seed when the host provides
 * it and a native control otherwise. A missing seed is a fallback, not an
 * error (AGENTS.md "DSH UI Component Library"): each renderer guards with
 * `primitives && typeof primitives.X === 'function'`, so a host whose
 * platform module table predates the seed still renders the whole card.
 *
 * The seed is resolved once by the bootstrap (requireRuntimeModules in
 * plugin.ts via createCard) and handed in through setPrimitivesModule; the
 * native fallbacks style themselves on the same --dsw-* token families.
 * @module dsh-plugin-obsidian-mem/client/primitives
 */
import type { ReactNode } from 'react';
export interface PrimitivesModule {
    Button?: unknown;
    Input?: unknown;
    Tag?: unknown;
    StateDot?: unknown;
    Toast?: unknown;
    SegmentedControl?: unknown;
}
/**
 * SetPrimitivesModule hands the bootstrap's resolved seed (or null) to the
 * renderers. createCard calls it once per mount.
 */
export declare function setPrimitivesModule(primitives: PrimitivesModule | null): void;
/** GetPrimitivesModule returns the resolved seed, or null for the fallback. */
export declare function getPrimitivesModule(): PrimitivesModule | null;
/** The button variants the card uses (the primitives' Button variant subset). */
export type ButtonVariant = 'primary' | 'ghost' | 'outline';
/** The tag tones the card uses (the primitives' Tag tone palette). */
export type TagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'quiet';
/** The state-dot semantics (the primitives' StateDot contract). */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';
/**
 * RenderButton draws the DSH Button atom (the --dsw-alias-button-* token
 * families, size 'sm': the card is a 28px context) with the card's inline
 * button as the fallback a host without the seed keeps.
 */
export declare function renderButton(opts: {
    label: string;
    variant?: ButtonVariant | undefined;
    disabled?: boolean | undefined;
    busy?: boolean | undefined;
    title?: string | undefined;
    onClick: () => void;
}): ReactNode;
/**
 * RenderInput draws the DSH Input atom (a wrapper span over the native
 * input; text-entry attributes pass through) with the card's inline input as
 * the fallback. onChange receives the text, never the raw event.
 */
export declare function renderInput(opts: {
    value: string;
    placeholder?: string | undefined;
    title?: string | undefined;
    id?: string | undefined;
    type?: 'text' | 'number' | undefined;
    disabled?: boolean | undefined;
    wide?: boolean | undefined;
    onChange: (text: string) => void;
}): ReactNode;
/** One selectable segment of RenderSegmented. */
export interface SegmentedOption<Value extends string> {
    value: Value;
    label: string;
}
/**
 * RenderSegmented draws the DSH SegmentedControl (the tablist with one
 * indicator; the owner holds the selection) with a native <select> as the
 * fallback. It picks one mode among mutually exclusive options (audit view,
 * vault mode, plan preview state).
 */
export declare function renderSegmented<Value extends string>(opts: {
    id: string;
    label: string;
    value: Value;
    options: readonly SegmentedOption<Value>[];
    disabled?: boolean | undefined;
    onChange: (next: Value) => void;
}): ReactNode;
/**
 * RenderTag draws the DSH Tag atom (the read-only 11px capsule, `tone`
 * selects the palette) with the card's native tag as the fallback.
 */
export declare function renderTag(tone: TagTone, text: string): ReactNode;
/**
 * RenderStateDot draws the DSH StateDot (green done / amber warning / red
 * error / spinner ongoing / neutral idle; aria-hidden, the row names it) with
 * the card's colored glyph as the fallback.
 */
export declare function renderStateDot(state: StateDotState): ReactNode;
/**
 * RenderToast draws the DSH Toast (the transient top-center banner that
 * holds, fades, and calls onDone) with the card's fixed banner as the
 * fallback. The owner keeps the mount (and the unmount timer); onDone lets
 * the seed end the same state change.
 */
export declare function renderToast(text: string, onDone: () => void): ReactNode;
//# sourceMappingURL=primitives.d.ts.map
