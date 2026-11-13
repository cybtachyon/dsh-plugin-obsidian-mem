/**
 * The Audit section: the read-only doctor pass (GET /obsidian-mem/audit),
 * the view selector for the bounded note rows, the top issues with ISSUE
 * severity above INFO, and the over-budget callout pointing at Dreaming.
 *
 * The audit runs only when the operator asks (it walks the vaults and probes
 * the collection once). Its budget report doubles as the Index section's
 * global-memory meter, so it travels up through onBudget.
 * @module dsh-plugin-obsidian-mem/client/sections/audit
 */

import type { ReactNode } from 'react'
import type { AuditReport, AuditView, GlobalBudgetReport } from '../../../service/lib/audit.js'
import { errorText, fetchAudit } from '../api.js'
import { formatBytes, formatCount } from '../format.js'
import {
  renderButton,
  renderSegmented,
  renderStateDot,
  renderTag,
  type SegmentedOption,
} from '../primitives.js'
import { react } from '../react.js'
import { RowHint } from '../cardRoot.js'
import {
  ERROR_BANNER_STYLE,
  HINT_STYLE,
  KEY_STYLE,
  MONO_STYLE,
  ROW_STYLE,
  WARNING_BANNER_STYLE,
} from '../styles.js'

const VIEW_OPTIONS: readonly SegmentedOption<AuditView>[] = [
  { value: 'full', label: 'Full' },
  { value: 'topStale', label: 'Top stale' },
  { value: 'oldestUnread', label: 'Oldest unread' },
]

/** Issues above this many are truncated with a counted tail. */
export const AUDIT_ISSUES_SHOWN = 8

/** Note rows above this many are truncated with a counted tail. */
export const AUDIT_ROWS_SHOWN = 10

// ISSUE before INFO: the operator reads what is wrong first.
const SEVERITY_RANK: Record<string, number> = { ISSUE: 0, INFO: 1 }

export interface AuditSectionProps {
  onBudget: (budget: GlobalBudgetReport) => void
}

export function AuditSection(props: AuditSectionProps): ReactNode {
  const [view, setView] = react.useState<AuditView>('full')
  const [report, setReport] = react.useState<AuditReport | null>(null)
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState<string | null>(null)

  const run = (target: AuditView): void => {
    setBusy(true)
    setError(null)
    fetchAudit(target).then(
      (payload) => {
        setBusy(false)
        setReport(payload.report)
        props.onBudget(payload.report.budget)
      },
      (failure: unknown) => {
        setBusy(false)
        setError(errorText(failure))
      },
    )
  }

  const pickView = (next: AuditView): void => {
    setView(next)
    // Switching the view only re-reads when a report is already on screen:
    // the selector picks the row order of a pass, it does not start one.
    if (report !== null) {
      run(next)
    }
  }

  const issues = report === null
    ? []
    : [...report.issues].sort((a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))

  return (
    <>
      <div style={ROW_STYLE}>
        {renderSegmented<AuditView>({
          id: 'obsidian-mem-audit-view',
          label: 'Audit view',
          value: view,
          options: VIEW_OPTIONS,
          disabled: busy,
          onChange: pickView,
        })}
        {renderButton({
          label: report === null ? 'Run audit' : 'Re-run audit',
          variant: 'primary',
          busy,
          onClick: () => run(view),
        })}
      </div>
      {error !== null && <div style={ERROR_BANNER_STYLE}>{error}</div>}
      {report === null && error === null && (
        <RowHint text="The audit reads vaults, index state, and budgets without writing anything." />
      )}
      {report !== null && (
        <>
          <div style={ROW_STYLE}>
            {renderStateDot(report.ok ? 'done' : 'warning')}
            <span style={KEY_STYLE}>
              {`${formatCount(report.stats.noteCount)} notes in ${formatCount(report.stats.vaultCount)} vaults, `
                + `${formatBytes(report.stats.totalBytes)}`}
            </span>
            {report.issues.length > 0 && renderTag(
              report.ok ? 'info' : 'danger',
              `${String(report.issues.length)} issues`,
            )}
          </div>
          {report.budget.overBudget && (
            <div style={WARNING_BANNER_STYLE}>
              {`Global memory index over budget: ${formatCount(report.budget.usedTokens)} of `
                + `${formatCount(report.budget.budgetTokens)} injected tokens. Ask the agent to run memory_dream, `
                + 'or start a run from the Dreaming section below.'}
            </div>
          )}
          {issues.slice(0, AUDIT_ISSUES_SHOWN).map((issue) => (
            <div key={issue.id} style={ROW_STYLE}>
              {renderTag(issue.severity === 'ISSUE' ? 'danger' : 'info', issue.severity)}
              <span style={{ flex: 1, minWidth: 240 }}>
                {issue.detail}
                <div style={HINT_STYLE}>{issue.remediation}</div>
              </span>
            </div>
          ))}
          {issues.length > AUDIT_ISSUES_SHOWN && (
            <RowHint text={`${String(issues.length - AUDIT_ISSUES_SHOWN)} more issues in the full report.`} />
          )}
          {report.rows.slice(0, AUDIT_ROWS_SHOWN).map((row) => (
            <div key={row.path} style={ROW_STYLE}>
              <span style={MONO_STYLE} title={row.path}>{row.path}</span>
              {renderTag('quiet', `reads ${String(row.readCount)}`)}
              {renderTag('quiet', formatBytes(row.sizeBytes))}
              {row.archived && renderTag('neutral', 'archived')}
            </div>
          ))}
          {report.totalRows > AUDIT_ROWS_SHOWN && (
            <RowHint
              text={`${String(report.totalRows - AUDIT_ROWS_SHOWN)} more rows in the "${report.view}" view.`}
            />
          )}
        </>
      )}
    </>
  )
}
