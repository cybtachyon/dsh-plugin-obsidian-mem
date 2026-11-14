/**
 * The card's shared inline styles, all themed through the shell's --dsw-*
 * design tokens (the same token families the primitives consume, with the
 * neutral fallback the local-infer card uses for hosts whose theme lacks a
 * token). Every control that has a primitive counterpart lives in
 * primitives.tsx; what remains here is card chrome: the settings-card frame,
 * section bodies, dense rows, banners, and the meter track.
 * @module dsh-plugin-obsidian-mem/client/styles
 */

import type { CSSProperties } from 'react'

const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, #1d1d1f)'
const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, #6e6e73)'
const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'
const LABEL_WARNING = 'var(--dsw-alias-label-warning, #ff9f0a)'
const LABEL_ERROR = 'var(--dsw-alias-label-error, #ff3b30)'
const FILL_WARNING = 'var(--dsw-alias-fill-warning, rgba(255,159,10,0.12))'
const FILL_ERROR = 'var(--dsw-alias-fill-error, rgba(255,59,48,0.12))'
const FILL_TERTIARY = 'var(--dsw-alias-background-tertiary, rgba(128,128,128,0.08))'
const BORDER_SECONDARY = 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.24))'
const ACCENT = 'var(--dsw-alias-accent, #0a84ff)'

/** The settings-card frame: the same fill and stroke the host cards use. */
export const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 16,
  borderRadius: 'var(--dsw-radius-xl, 12px)',
  background: 'var(--dsw-alias-settings-card-fill, rgba(128,128,128,0.06))',
  border: '1px solid var(--dsw-alias-settings-card-stroke, rgba(128,128,128,0.18))',
  color: LABEL_PRIMARY,
  fontSize: 13,
  lineHeight: 1.45,
  maxWidth: 720,
}

/** The card header row: the title and the whole-plugin state badge. */
export const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
}

/** A collapsible section: the <details> wrapper and its <summary> head. */
export const SECTION_STYLE: CSSProperties = {
  border: `1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.14))`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  padding: '6px 10px',
}

export const SUMMARY_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  listStyle: 'none',
}

export const SECTION_BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 8,
}

/** One dense key/value or list row. */
export const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

/** A quiet label inside a row (the key of a key/value pair). */
export const KEY_STYLE: CSSProperties = { color: LABEL_SECONDARY }

/** A group heading (the Configuration section's knob groups). */
export const GROUP_HEADING_STYLE: CSSProperties = { ...KEY_STYLE, fontWeight: 600 }

/** The quietest text tier: hints, help lines, and empty states. */
export const HINT_STYLE: CSSProperties = { color: LABEL_TERTIARY, fontSize: 12 }

/** A mono value (paths, expressions, ids). */
export const MONO_STYLE: CSSProperties = {
  fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)',
  fontSize: 12,
  wordBreak: 'break-all',
}

/** Warning and error banners (the degraded index, over-budget, verbatim API errors). */
export const WARNING_BANNER_STYLE: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: FILL_WARNING,
  color: LABEL_WARNING,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

export const ERROR_BANNER_STYLE: CSSProperties = {
  ...WARNING_BANNER_STYLE,
  background: FILL_ERROR,
  color: LABEL_ERROR,
}

/** The budget meter: a track with a fill whose width carries the usage. */
export const METER_TRACK_STYLE: CSSProperties = {
  position: 'relative',
  height: 6,
  width: '100%',
  maxWidth: 280,
  borderRadius: 3,
  background: FILL_TERTIARY,
  overflow: 'hidden',
}

export function meterFillStyle(percent: number, overBudget: boolean): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    width: `${String(percent)}%`,
    background: overBudget ? LABEL_ERROR : ACCENT,
    borderRadius: 3,
  }
}

/** The native fallbacks for the guarded primitive renderers. */
export const NATIVE_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 28,
  padding: '0 10px',
  borderRadius: 8,
  border: `1px solid ${BORDER_SECONDARY}`,
  background: FILL_TERTIARY,
  color: LABEL_PRIMARY,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

export const NATIVE_PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...NATIVE_BUTTON_STYLE,
  background: ACCENT,
  borderColor: ACCENT,
  color: '#fff',
}

export const NATIVE_INPUT_STYLE: CSSProperties = {
  height: 28,
  padding: '0 8px',
  borderRadius: 8,
  border: `1px solid ${BORDER_SECONDARY}`,
  background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
  color: LABEL_PRIMARY,
  font: 'inherit',
  fontSize: 12,
  minWidth: 0,
}

export const TAG_BASE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  borderRadius: 10,
  fontSize: 11,
  lineHeight: 1,
  whiteSpace: 'nowrap',
}

export const TAG_TONE_STYLES: Record<string, CSSProperties> = {
  neutral: { color: LABEL_SECONDARY, background: FILL_TERTIARY },
  info: { color: ACCENT, background: 'var(--dsw-alias-fill-quaternary, rgba(10,132,255,0.12))' },
  success: { color: 'var(--dsw-alias-label-success, #34c38f)', background: 'var(--dsw-alias-fill-success, rgba(52,195,143,0.12))' },
  warning: { color: LABEL_WARNING, background: FILL_WARNING },
  danger: { color: LABEL_ERROR, background: FILL_ERROR },
  quiet: { color: LABEL_TERTIARY, background: 'transparent' },
}

/** The native Toast fallback: a top-center banner the owner unmounts. */
export const TOAST_STYLE: CSSProperties = {
  position: 'fixed',
  top: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 1000,
  padding: '8px 14px',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1, rgba(28,28,30,0.92))',
  border: `1px solid ${BORDER_SECONDARY}`,
  color: LABEL_PRIMARY,
  fontSize: 13,
  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
}

/** A pre-formatted text block (the dream plan body). */
export const PRE_STYLE: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  color: LABEL_SECONDARY,
  maxHeight: 240,
  overflow: 'auto',
}

/** The disabled look shared by native fallbacks while a request is in flight. */
export const DISABLED_STYLE: CSSProperties = { opacity: 0.55, cursor: 'default' }
