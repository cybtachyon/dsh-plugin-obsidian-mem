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
import { budgetPercent, formatAge, formatCount } from '../format.js';
import { renderStateDot, renderTag } from '../primitives.js';
import { react } from '../react.js';
import { RowHint } from '../cardRoot.js';
import { KEY_STYLE, METER_TRACK_STYLE, MONO_STYLE, ROW_STYLE, WARNING_BANNER_STYLE, meterFillStyle, } from '../styles.js';
export function IndexStatusSection(props) {
    const status = props.status;
    if (status === null) {
        return react.createElement(RowHint, { text: "Reading the memory status\u2026" });
    }
    const { milvus, indexer, model, budgets } = status;
    return (react.createElement(react.Fragment, null,
        (milvus.degraded || status.state === 'degraded') && (react.createElement("div", { style: WARNING_BANNER_STYLE }, `Index degraded: ${milvus.error ?? 'the Milvus backend reported no detail.'}`)),
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Milvus"),
            renderStateDot(milvus.degraded ? 'warning' : status.state === 'ready' ? 'done' : 'idle'),
            renderTag('quiet', milvus.mode),
            react.createElement("span", { style: MONO_STYLE }, milvus.address ?? `spawn ${milvus.dbPath}`),
            milvus.version !== null && renderTag('neutral', `v ${milvus.version}`)),
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Indexer"),
            indexer === null
                ? react.createElement("span", null, "not started")
                : (react.createElement(react.Fragment, null,
                    renderTag('success', `${formatCount(indexer.indexed)} indexed`),
                    renderTag('info', `${formatCount(indexer.pending)} pending`),
                    indexer.errors > 0
                        ? renderTag('danger', `${formatCount(indexer.errors)} errors`)
                        : renderTag('quiet', '0 errors')))),
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Model"),
            react.createElement("span", { style: MONO_STYLE }, `${model.id} (${model.dtype})`),
            react.createElement("span", { style: KEY_STYLE }, "vectorDim"),
            react.createElement("span", null, String(status.vectorDim))),
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Budgets"),
            react.createElement("span", null, `turn recall ${formatCount(budgets.turnStartRecallTokens)} t · `
                + `global ${formatCount(budgets.globalMemoryTokens)} t · `
                + `topK ${String(budgets.searchTopK)}`)),
        react.createElement(BudgetMeter, { budget: props.lastBudget, fallbackBudget: budgets.globalMemoryTokens }),
        status.dream.lastDreamAt !== null && (react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Last dream"),
            react.createElement("span", null, formatAge(status.dream.lastDreamAt, Date.now()))))));
}
// The global-memory meter. The measured numbers only exist after an audit
// pass (report.budget echoes the global budget index), so pre-audit the
// section states that instead of drawing a zero bar that reads as "all
// budget free" (it is not a measurement, and a false all-clear is worse than
// none). Over budget fills the track red: the remedy pointer lives in the
// Audit section's callout.
function BudgetMeter(props) {
    if (props.budget === null) {
        return (react.createElement(RowHint, { text: `Global memory budget: ${formatCount(props.fallbackBudget)} tokens configured. Run an audit below to measure injected-token usage.` }));
    }
    const percent = budgetPercent(props.budget.usedTokens, props.budget.budgetTokens);
    return (react.createElement("div", { style: ROW_STYLE },
        react.createElement("span", { style: KEY_STYLE }, "Global memory"),
        react.createElement("div", { style: METER_TRACK_STYLE, role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent },
            react.createElement("div", { style: meterFillStyle(percent, props.budget.overBudget) })),
        react.createElement("span", null, `${formatCount(props.budget.usedTokens)} / ${formatCount(props.budget.budgetTokens)} tokens injected`)));
}
//# sourceMappingURL=indexStatus.js.map
