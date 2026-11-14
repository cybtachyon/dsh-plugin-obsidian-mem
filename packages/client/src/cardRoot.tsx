/**
 * The card root: header, the 10 s status poll, and the six collapsible
 * sections (Vaults, Configuration, Index status, Audit, Dreaming, Search
 * test).
 *
 * The poll owns the only shared data (GET /obsidian-mem/status; the interval
 * is cleared on unmount and a re-render after unmount never lands). Every
 * other fetch belongs to its section; the one cross-section flow is the
 * global-budget meter: the audit pass measures injected tokens, so the Audit
 * section hands its budget report up and the Index section displays it.
 * @module dsh-plugin-obsidian-mem/client/cardRoot
 */

import type { ReactNode } from 'react'
import type { GlobalBudgetReport } from '../../service/lib/audit.js'
import { errorText, fetchStatus, type StatusPayload } from './api.js'
import { renderStateDot, renderTag, type StateDotState, type TagTone } from './primitives.js'
import { react } from './react.js'
import {
  CARD_STYLE,
  HEADER_STYLE,
  HINT_STYLE,
  SECTION_BODY_STYLE,
  SECTION_STYLE,
  SUMMARY_STYLE,
  WARNING_BANNER_STYLE,
} from './styles.js'
import { AuditSection } from './sections/audit.js'
import { ConfigurationSection } from './sections/configuration.js'
import { DreamingSection } from './sections/dreaming.js'
import { IndexStatusSection } from './sections/indexStatus.js'
import { SearchSection } from './sections/search.js'
import { VaultsSection } from './sections/vaults.js'

/** How often the card re-reads GET /obsidian-mem/status while mounted. */
export const STATUS_POLL_INTERVAL_MS = 10_000

// The whole-plugin state badge: the seam phase as dot + capsule.
const STATE_DOTS: Record<StatusPayload['state'], StateDotState> = {
  ready: 'done',
  provisioning: 'ongoing',
  degraded: 'warning',
  inactive: 'idle',
}
const STATE_TONES: Record<StatusPayload['state'], TagTone> = {
  ready: 'success',
  provisioning: 'info',
  degraded: 'warning',
  inactive: 'quiet',
}

/** CardRoot is the component the slot registration mounts. */
export function CardRoot(): ReactNode {
  const [status, setStatus] = react.useState<StatusPayload | null>(null)
  const [statusError, setStatusError] = react.useState<string | null>(null)
  const [lastBudget, setLastBudget] = react.useState<GlobalBudgetReport | null>(null)
  const [pollKey, setPollKey] = react.useState(0)

  // One poll per pollKey (mount) plus the fixed interval; the cleanup clears
  // the interval and lands a late response, so an unmounted card never
  // touches react state.
  react.useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      fetchStatus().then(
        (payload) => {
          if (!cancelled) {
            setStatus(payload)
            setStatusError(null)
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setStatusError(errorText(error))
          }
        },
      )
    }
    poll()
    const timer: ReturnType<typeof setInterval> = setInterval(poll, STATUS_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pollKey])

  /** Refresh re-runs the immediate poll (vault and schedule mutations call it). */
  const refresh = (): void => setPollKey((key) => key + 1)

  const state = status?.state ?? 'inactive'
  return (
    <section style={CARD_STYLE}>
      <header style={HEADER_STYLE}>
        <span>Obsidian Mem</span>
        {renderStateDot(STATE_DOTS[state])}
        {renderTag(STATE_TONES[state], state)}
      </header>
      {statusError !== null && (
        <div style={WARNING_BANNER_STYLE}>{`Memory routes unreachable: ${statusError}`}</div>
      )}
      <Section title="Vaults" badge={countBadge(status === null ? null : String(status.vaults.length))} defaultOpen>
        <VaultsSection status={status} refresh={refresh} />
      </Section>
      <Section title="Configuration">
        <ConfigurationSection />
      </Section>
      <Section title="Index status" defaultOpen>
        <IndexStatusSection status={status} lastBudget={lastBudget} />
      </Section>
      <Section title="Audit">
        <AuditSection onBudget={setLastBudget} />
      </Section>
      <Section title="Dreaming">
        <DreamingSection status={status} refresh={refresh} />
      </Section>
      <Section title="Search test">
        <SearchSection />
      </Section>
    </section>
  )
}

function countBadge(text: string | null): ReactNode {
  return text === null ? null : renderTag('quiet', text)
}

// One collapsible card section: a <details> head with the title and an
// optional badge, stacking its content below. The stacked card layout is
// deliberately not the primitives' 24px DisclosureRow row (README: a card
// that stacks a name over its content belongs in the feature package).
interface SectionProps {
  title: string
  badge?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

function Section(props: SectionProps): ReactNode {
  return (
    <details style={SECTION_STYLE} {...(props.defaultOpen === true ? { defaultOpen: true } : {})}>
      <summary style={SUMMARY_STYLE}>
        <span>{props.title}</span>
        {props.badge ?? null}
      </summary>
      <div style={SECTION_BODY_STYLE}>{props.children}</div>
    </details>
  )
}

/** RowHint is the shared quiet hint line sections use for empty states. */
export function RowHint({ text }: { text: string }): ReactNode {
  return <div style={HINT_STYLE}>{text}</div>
}
