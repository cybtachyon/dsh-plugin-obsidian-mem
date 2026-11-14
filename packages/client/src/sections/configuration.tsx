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

import type { ReactNode } from 'react'
import type { CardEditableConfig } from '../../../service/lib/index.js'
import {
  ERROR_CODES,
  errorText,
  fetchCardSettings,
  isApiError,
  resetCardSettings,
  updateCardSettings,
  type CardEditablePatch,
  type CardSettingsPayload,
} from '../api.js'
import {
  renderButton,
  renderInput,
  renderSegmented,
  renderTag,
  type SegmentedOption,
} from '../primitives.js'
import { react } from '../react.js'
import { RowHint } from '../cardRoot.js'
import { useToast } from '../toast.js'
import {
  ERROR_BANNER_STYLE,
  GROUP_HEADING_STYLE,
  HINT_STYLE,
  KEY_STYLE,
  ROW_STYLE,
  WARNING_BANNER_STYLE,
} from '../styles.js'

/** The control a knob renders as: width picker, number, text, or off/on. */
export type ConfigFieldKind = 'dim' | 'number' | 'text' | 'toggle'

/** One whitelisted knob: its dot-path, layout placement, and control copy. */
export interface ConfigFieldSpec {
  /** The CARD_SETTINGS_KEYS leaf path (configuration.spec.ts pins the set). */
  path: string
  group: string
  label: string
  kind: ConfigFieldKind
  /** The one-line hover tooltip. */
  tooltip: string
  /** The placeholder shown while the draft is blank: the host default when
   * one exists (configuration.spec.ts pins those copies against the service
   * and core constants), an example for knobs whose default is empty. */
  placeholder?: string
  /** A quiet hint line rendered under the field row. */
  hint?: string
  /** A toggle's dot-path that gates this row: the control stays disabled
   * while that draft is not on (the Keyword LLM rows behind llm.enabled). */
  gatedBy?: string
}

// The field table drives seed, dirty diff, rows, and the patch in one pass;
// the group order and copy follow the TASK-008 layout. Placeholder defaults
// are display copy only (core constants and the config schema stay
// authoritative); configuration.spec.ts pins them so the copies cannot drift.
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  {
    path: 'vectorDim',
    group: 'Retrieval',
    label: 'Vector width',
    kind: 'dim',
    tooltip: 'Embedding width stored per note; the full 384 or a lossy truncation',
    hint: 'Lossy widths trade recall for speed; changes force a full re-index.',
  },
  {
    path: 'budgets.searchTopK',
    group: 'Retrieval',
    label: 'Search top K',
    kind: 'number',
    tooltip: 'Result count memory_search returns when the caller omits limit',
    placeholder: '6',
  },
  {
    path: 'budgets.turnStartRecallTokens',
    group: 'Recall budgets',
    label: 'Turn-start tokens',
    kind: 'number',
    tooltip: 'Token budget one turn-start recall injection may spend',
    placeholder: '1200',
  },
  {
    path: 'budgets.globalMemoryTokens',
    group: 'Recall budgets',
    label: 'Global memory tokens',
    kind: 'number',
    tooltip: 'Token ceiling for all recall injected across one session',
    placeholder: '1500',
  },
  {
    path: 'budgets.readSections',
    group: 'Recall budgets',
    label: 'Read sections',
    kind: 'number',
    tooltip: 'Most sections a Read-tool recall may inject',
    placeholder: '2',
  },
  {
    path: 'budgets.readSectionTokens',
    group: 'Recall budgets',
    label: 'Read section tokens',
    kind: 'number',
    tooltip: 'Token budget each injected Read-tool section may spend',
    placeholder: '350',
  },
  {
    path: 'budgets.thinkShotsPerTurn',
    group: 'Recall budgets',
    label: 'Think shots per turn',
    kind: 'number',
    tooltip: 'Most keyword-extraction shots one turn may spend',
    placeholder: '3',
  },
  {
    path: 'model.id',
    group: 'Embedding model',
    label: 'Model id',
    kind: 'text',
    tooltip: 'ONNX model id used to embed every note',
    placeholder: 'Xenova/multilingual-e5-small',
    hint: 'Changing the model re-embeds every note.',
  },
  {
    path: 'model.cacheDir',
    group: 'Embedding model',
    label: 'Model cache dir',
    kind: 'text',
    tooltip: 'Directory transformers.js reads and downloads the model in',
    placeholder: '~/.dsh/obsidian-mem-db/models',
    hint: 'The model is downloaded here on first use.',
  },
  {
    path: 'milvus.dbPath',
    group: 'Database',
    label: 'Database path',
    kind: 'text',
    tooltip: 'Milvus-Lite data directory; the running server picks it up on the next host restart',
    placeholder: '~/.dsh/obsidian-mem-db',
  },
  {
    path: 'llm.enabled',
    group: 'Keyword LLM',
    label: 'Keyword LLM',
    kind: 'toggle',
    tooltip: 'Optional OpenAI-compatible endpoint augmenting wake-keyword extraction',
  },
  {
    path: 'llm.baseUrl',
    group: 'Keyword LLM',
    label: 'Base URL',
    kind: 'text',
    tooltip: 'OpenAI-compatible endpoint base URL',
    placeholder: 'https://api.example.com/v1',
    gatedBy: 'llm.enabled',
  },
  {
    path: 'llm.model',
    group: 'Keyword LLM',
    label: 'LLM model',
    kind: 'text',
    tooltip: 'Model name the keyword extraction asks for',
    placeholder: 'gpt-4o-mini',
    gatedBy: 'llm.enabled',
  },
  {
    path: 'llm.apiKeyEnv',
    group: 'Keyword LLM',
    label: 'API key env',
    kind: 'text',
    tooltip: 'Name of the environment variable holding the key; never the key itself',
    placeholder: 'OPENAI_API_KEY',
    gatedBy: 'llm.enabled',
  },
]

const VECTOR_DIM_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: '384', label: '384 full' },
  { value: '320', label: '320 lossy' },
  { value: '256', label: '256 lossy' },
  { value: '192', label: '192 lossy' },
  { value: '128', label: '128 lossy' },
]

const LLM_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
]

// The reset button copy the armed (Confirm reset) and disarmed (Reset all
// to profile settings) buttons share.
const RESET_ALL_TITLE = 'Drop every card override; the profile settings win again'

// PickFieldPath walks one dot-path through a settings view or the override
// tree; a missing or non-object intermediate answers undefined (unset).
function pickFieldPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// FormatFieldSeed renders one stored value as its draft string: numbers and
// strings verbatim, the llm toggle as the segmented off/on vocabulary.
function formatFieldSeed(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value ?? '')
}

function seedDrafts(settings: CardEditableConfig): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const spec of CONFIG_FIELDS) {
    drafts[spec.path] = formatFieldSeed(pickFieldPath(settings, spec.path))
  }
  return drafts
}

function isCustomField(overrides: CardSettingsPayload['overrides'], path: string): boolean {
  return pickFieldPath(overrides, path) !== undefined
}

/** One knob's diff input: the loaded baseline, the current draft, and its override state. */
export interface ConfigFieldDraft {
  path: string
  kind: ConfigFieldKind
  baseline: string
  draft: string
  custom: boolean
}

/** The apply body: nested whitelisted leaves to set plus override paths to drop. */
export interface ConfigSettingsPatch {
  set: CardEditablePatch
  unset: string[]
}

// ParseFieldValue turns a non-blank draft into the wire value, or null for
// a draft that cannot become one (a number field with no number in it).
// Range and positivity stay the host's (the schema rejects the whole patch
// with a message the banner shows verbatim).
function parseFieldValue(kind: ConfigFieldKind, trimmed: string): string | number | boolean | null {
  if (kind === 'number' || kind === 'dim') {
    const value = Number(trimmed)
    return Number.isFinite(value) ? value : null
  }
  if (kind === 'toggle') return trimmed === 'on'
  return trimmed
}

function setNestedPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    const existing = node[part]
    const nested = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
    node[part] = nested
    node = nested
  }
  node[parts[parts.length - 1]!] = value
}

/**
 * BuildSettingsPatch diffs drafts against the loaded view: a changed field
 * parses into the nested `set` object; a blanked text field that carries an
 * override joins `unset` (the store's clear rule deletes the key so the
 * profile row wins again); a blank number field, a blank field with no
 * override to drop, and an unparsable number send nothing.
 */
export function buildSettingsPatch(fields: readonly ConfigFieldDraft[]): ConfigSettingsPatch {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const field of fields) {
    if (field.draft === field.baseline) continue
    const trimmed = field.draft.trim()
    if (trimmed === '') {
      if (field.custom && field.kind === 'text') unset.push(field.path)
      continue
    }
    const value = parseFieldValue(field.kind, trimmed)
    if (value === null) continue
    setNestedPath(set, field.path, value)
  }
  return { set: set as CardEditablePatch, unset }
}

function fieldDrafts(
  view: CardSettingsPayload,
  drafts: Record<string, string>,
): ConfigFieldDraft[] {
  const seed = seedDrafts(view.settings)
  return CONFIG_FIELDS.map((spec) => ({
    path: spec.path,
    kind: spec.kind,
    baseline: seed[spec.path] ?? '',
    draft: drafts[spec.path] ?? '',
    custom: isCustomField(view.overrides, spec.path),
  }))
}

export function ConfigurationSection(): ReactNode {
  const [view, setView] = react.useState<CardSettingsPayload | null>(null)
  const [drafts, setDrafts] = react.useState<Record<string, string> | null>(null)
  const [loadError, setLoadError] = react.useState<string | null>(null)
  const [error, setError] = react.useState<string | null>(null)
  const [busy, setBusy] = react.useState(false)
  const [confirmReset, setConfirmReset] = react.useState(false)
  const toast = useToast()

  react.useEffect(() => {
    let cancelled = false
    fetchCardSettings().then(
      (payload) => {
        if (!cancelled) {
          setView(payload)
          setDrafts(seedDrafts(payload.settings))
          setLoadError(null)
        }
      },
      (failure: unknown) => {
        if (!cancelled) {
          setLoadError(errorText(failure))
        }
      },
    )
    return () => {
      cancelled = true
    }
    // One read per mount; every mutation re-seeds from the view it answers.
  }, [])

  const setField = (path: string, text: string): void => {
    setDrafts((current) => current === null ? current : { ...current, [path]: text })
  }

  // Accept re-seeds from the fresh view the apply/reset already answers (no
  // follow-up GET). settings_busy keeps the controls as they are: an apply
  // is still in flight host-side, so only real failures flash the banner.
  const accept = (fresh: CardSettingsPayload): void => {
    setBusy(false)
    setView(fresh)
    setDrafts(seedDrafts(fresh.settings))
    toast.show('Settings applied')
  }
  const reject = (failure: unknown): void => {
    setBusy(false)
    if (!isApiError(failure) || failure.code !== ERROR_CODES.settingsBusy) {
      setError(errorText(failure))
    }
  }

  const applyChanges = (patch: ConfigSettingsPatch): void => {
    if (view === null || drafts === null) {
      return
    }
    setBusy(true)
    setError(null)
    updateCardSettings(patch.set, patch.unset).then(accept, reject)
  }

  const resetAll = (): void => {
    setBusy(true)
    setError(null)
    setConfirmReset(false)
    resetCardSettings().then(accept, reject)
  }

  const toastNode = toast.node

  if (view === null || drafts === null) {
    return (
      <>
        {toastNode}
        {loadError !== null && <div style={ERROR_BANNER_STYLE}>{loadError}</div>}
        <RowHint text={loadError === null ? 'Loading configuration\u2026' : 'Configuration not loaded.'} />
      </>
    )
  }

  // One diff pass drives the Apply gate and the POST body: a patch with no
  // set leaves and no unset paths (blank fields only) is not worth a round
  // trip, so Apply stays gated exactly like an unchanged form does.
  const patch = buildSettingsPatch(fieldDrafts(view, drafts))
  const patchEmpty = Object.keys(patch.set).length === 0 && patch.unset.length === 0
  const restartPending = view.restartPending

  const body: ReactNode[] = []
  let lastGroup = ''
  for (const spec of CONFIG_FIELDS) {
    if (spec.group !== lastGroup) {
      lastGroup = spec.group
      body.push(<div key={`group-${spec.group}`} style={GROUP_HEADING_STYLE}>{spec.group}</div>)
    }
    const disabled = busy
      || (spec.gatedBy !== undefined && (drafts[spec.gatedBy] ?? 'off') !== 'on')
    const draft = drafts[spec.path] ?? ''
    const control = spec.kind === 'dim' || spec.kind === 'toggle'
      ? renderSegmented<string>({
        id: `obsidian-mem-config-${spec.path}`,
        label: spec.label,
        value: draft,
        options: spec.kind === 'dim' ? VECTOR_DIM_OPTIONS : LLM_OPTIONS,
        disabled,
        onChange: (next) => setField(spec.path, next),
      })
      : renderInput({
        value: draft,
        type: spec.kind === 'number' ? 'number' : 'text',
        placeholder: spec.placeholder,
        title: spec.tooltip,
        disabled,
        onChange: (text) => setField(spec.path, text),
      })
    body.push(
      <div key={spec.path} style={ROW_STYLE}>
        <span style={KEY_STYLE}>{spec.label}</span>
        {isCustomField(view.overrides, spec.path) && renderTag('info', 'custom')}
        {control}
        {restartPending.includes(spec.path) && renderTag('warning', 'restart to apply')}
      </div>,
    )
    if (spec.hint !== undefined) {
      body.push(<div key={`hint-${spec.path}`} style={HINT_STYLE}>{spec.hint}</div>)
    }
  }

  return (
    <>
      {toastNode}
      {restartPending.length > 0 && (
        <div style={WARNING_BANNER_STYLE}>{`Restart the host to apply: ${restartPending.join(', ')}`}</div>
      )}
      {body}
      <div style={ROW_STYLE}>
        {renderButton({
          label: 'Apply changes',
          variant: 'primary',
          busy,
          disabled: patchEmpty,
          title: 'Save the edited fields as card overrides',
          onClick: () => applyChanges(patch),
        })}
        {confirmReset ? (
          <>
            {renderButton({
              label: 'Confirm reset',
              variant: 'outline',
              busy,
              title: RESET_ALL_TITLE,
              onClick: resetAll,
            })}
            {renderButton({ label: 'Cancel', onClick: () => setConfirmReset(false) })}
          </>
        ) : (
          renderButton({
            label: 'Reset all to profile settings',
            busy,
            title: RESET_ALL_TITLE,
            onClick: () => setConfirmReset(true),
          })
        )}
      </div>
      {error !== null && <div style={ERROR_BANNER_STYLE}>{error}</div>}
    </>
  )
}
