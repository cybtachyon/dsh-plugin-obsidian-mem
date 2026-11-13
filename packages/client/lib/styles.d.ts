/**
 * The card's shared inline styles, all themed through the shell's --dsw-*
 * design tokens (the same token families the primitives consume, with the
 * neutral fallback the local-infer card uses for hosts whose theme lacks a
 * token). Every control that has a primitive counterpart lives in
 * primitives.tsx; what remains here is card chrome: the settings-card frame,
 * section bodies, dense rows, banners, and the meter track.
 * @module dsh-plugin-obsidian-mem/client/styles
 */
import type { CSSProperties } from 'react';
/** The settings-card frame: the same fill and stroke the host cards use. */
export declare const CARD_STYLE: CSSProperties;
/** The card header row: the title and the whole-plugin state badge. */
export declare const HEADER_STYLE: CSSProperties;
/** A collapsible section: the <details> wrapper and its <summary> head. */
export declare const SECTION_STYLE: CSSProperties;
export declare const SUMMARY_STYLE: CSSProperties;
export declare const SECTION_BODY_STYLE: CSSProperties;
/** One dense key/value or list row. */
export declare const ROW_STYLE: CSSProperties;
/** A quiet label inside a row (the key of a key/value pair). */
export declare const KEY_STYLE: CSSProperties;
/** The quietest text tier: hints, help lines, and empty states. */
export declare const HINT_STYLE: CSSProperties;
/** A mono value (paths, expressions, ids). */
export declare const MONO_STYLE: CSSProperties;
/** Warning and error banners (the degraded index, over-budget, verbatim API errors). */
export declare const WARNING_BANNER_STYLE: CSSProperties;
export declare const ERROR_BANNER_STYLE: CSSProperties;
/** The budget meter: a track with a fill whose width carries the usage. */
export declare const METER_TRACK_STYLE: CSSProperties;
export declare function meterFillStyle(percent: number, overBudget: boolean): CSSProperties;
/** The native fallbacks for the guarded primitive renderers. */
export declare const NATIVE_BUTTON_STYLE: CSSProperties;
export declare const NATIVE_PRIMARY_BUTTON_STYLE: CSSProperties;
export declare const NATIVE_INPUT_STYLE: CSSProperties;
export declare const TAG_BASE_STYLE: CSSProperties;
export declare const TAG_TONE_STYLES: Record<string, CSSProperties>;
/** The native Toast fallback: a top-center banner the owner unmounts. */
export declare const TOAST_STYLE: CSSProperties;
/** A pre-formatted text block (the dream plan body). */
export declare const PRE_STYLE: CSSProperties;
/** The disabled look shared by native fallbacks while a request is in flight. */
export declare const DISABLED_STYLE: CSSProperties;
//# sourceMappingURL=styles.d.ts.map
