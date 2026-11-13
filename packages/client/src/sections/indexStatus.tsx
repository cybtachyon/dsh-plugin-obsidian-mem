/**
 * The Index status section: the seam phase and the Milvus backend (mode,
 * address, version, degradation banner with the host's own error text), the
 * indexer progress counters, the embedder model and vectorDim readout, the
 * configured recall budgets, and the global-memory meter.
 *
 * The meter visualizes the LAST audit pass's budget report (the same
 * globalMemoryIndex numbers the audit's budget lines name): used tokens
 * against `budgets.globalMemoryTokens`, filled red past the budget. Before
 * any audit ran this process it says so instead of drawing an empty bar.
 * @module dsh-plugin-obsidian-mem/client/sections/indexStatus
 */

import type { ReactNode } from 'react'
import type { GlobalBudgetReport } from '../../../service/lib/audit.js'
import type { StatusPayload } from '../api.js'
import { budgetPercent, formatAge, formatCount } from '../format.js'
import { renderStateDot, renderTag } from '../primitives.js'
import { react } from '../react.js'
import { RowHint } from '../cardRoot.js'
import {
  KEY_STYLE,
  METER_TRACK_STYLE,
  MONO_STYLE,
  ROW_STYLE,
  WARNING_BANNER_STYLE,
  meterFillStyle,
} from '../styles.js'

export interface IndexStatusSectionProps {
  status: StatusPayload | null
  lastBudget: GlobalBudgetReport | null
}

export function IndexStatusSection(props: IndexStatusSectionProps): ReactNode {
  const status = props.status
  if (status === null) {
    return <RowHint text="Reading the memory status…" />
  }
  const { milvus, indexer, model, budgets } = status
  return (
    <>
      {(milvus.degraded || status.state === 'degraded') && (
        <div style={WARNING_BANNER_STYLE}>
          {`Index degraded: ${milvus.error ?? 'the Milvus backend reported no detail.'}`}
        </div>
      )}
      <div style={ROW_STYLE}>
        <span style={KEY_STYLE}>Milvus</span>
        {renderStateDot(milvus.degraded ? 'warning' : status.state === 'ready' ? 'done' : 'idle')}
        {renderTag('quiet', milvus.mode)}
        <span style={MONO_STYLE}>
          {milvus.address ?? `spawn ${milvus.dbPath}`}
        </span>
        {milvus.version !== null && renderTag('neutral', `v ${milvus.version}`)}
      </div>
      <div style={ROW_STYLE}>
        <span style={KEY_STYLE}>Indexer</span>
        {indexer === null
          ? <span>not started</span>
          : (
            <>
              {renderTag('success', `${formatCount(indexer.indexed)} indexed`)}
              {renderTag('info', `${formatCount(indexer.pending)} pending`)}
              {indexer.errors > 0
                ? renderTag('danger', `${formatCount(indexer.errors)} errors`)
                : renderTag('quiet', '0 errors')}
            </>
          )}
      </div>
      <div style={ROW_STYLE}>
        <span style={KEY_STYLE}>Model</span>
        <span style={MONO_STYLE}>{`${model.id} (${model.dtype})`}</span>
        <span style={KEY_STYLE}>vectorDim</span>
        <span>{String(status.vectorDim)}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={KEY_STYLE}>Budgets</span>
        <span>
          {`turn recall ${formatCount(budgets.turnStartRecallTokens)} t · `
            + `global ${formatCount(budgets.globalMemoryTokens)} t · `
            + `topK ${String(budgets.searchTopK)}`}
        </span>
      </div>
      <BudgetMeter budget={props.lastBudget} fallbackBudget={budgets.globalMemoryTokens} />
      {status.dream.lastDreamAt !== null && (
        <div style={ROW_STYLE}>
          <span style={KEY_STYLE}>Last dream</span>
          <span>{formatAge(status.dream.lastDreamAt, Date.now())}</span>
        </div>
      )}
    </>
  )
}

// The global-memory meter. The measured numbers only exist after an audit
// pass (report.budget echoes the global budget index), so pre-audit the
// section states that instead of drawing a zero bar that reads as "all
// budget free" (it is not a measurement, and a false all-clear is worse than
// none). Over budget fills the track red: the remedy pointer lives in the
// Audit section's callout.
function BudgetMeter(props: {
  budget: GlobalBudgetReport | null
  fallbackBudget: number
}): ReactNode {
  if (props.budget === null) {
    return (
      <RowHint
        text={`Global memory budget: ${formatCount(props.fallbackBudget)} tokens configured. Run an audit below to measure injected-token usage.`}
      />
    )
  }
  const percent = budgetPercent(props.budget.usedTokens, props.budget.budgetTokens)
  return (
    <div style={ROW_STYLE}>
      <span style={KEY_STYLE}>Global memory</span>
      <div
        style={METER_TRACK_STYLE}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div style={meterFillStyle(percent, props.budget.overBudget)} />
      </div>
      <span>
        {`${formatCount(props.budget.usedTokens)} / ${formatCount(props.budget.budgetTokens)} tokens injected`}
      </span>
    </div>
  )
}
