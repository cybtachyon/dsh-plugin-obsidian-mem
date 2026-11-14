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
import { errorText, fetchStatus } from './api.js';
import { renderStateDot, renderTag } from './primitives.js';
import { react } from './react.js';
import { CARD_STYLE, HEADER_STYLE, HINT_STYLE, SECTION_BODY_STYLE, SECTION_STYLE, SUMMARY_STYLE, WARNING_BANNER_STYLE, } from './styles.js';
import { AuditSection } from './sections/audit.js';
import { ConfigurationSection } from './sections/configuration.js';
import { DreamingSection } from './sections/dreaming.js';
import { IndexStatusSection } from './sections/indexStatus.js';
import { SearchSection } from './sections/search.js';
import { VaultsSection } from './sections/vaults.js';
/** How often the card re-reads GET /obsidian-mem/status while mounted. */
export const STATUS_POLL_INTERVAL_MS = 10_000;
// The whole-plugin state badge: the seam phase as dot + capsule.
const STATE_DOTS = {
    ready: 'done',
    provisioning: 'ongoing',
    degraded: 'warning',
    inactive: 'idle',
};
const STATE_TONES = {
    ready: 'success',
    provisioning: 'info',
    degraded: 'warning',
    inactive: 'quiet',
};
/** CardRoot is the component the slot registration mounts. */
export function CardRoot() {
    const [status, setStatus] = react.useState(null);
    const [statusError, setStatusError] = react.useState(null);
    const [lastBudget, setLastBudget] = react.useState(null);
    const [pollKey, setPollKey] = react.useState(0);
    // One poll per pollKey (mount) plus the fixed interval; the cleanup clears
    // the interval and lands a late response, so an unmounted card never
    // touches react state.
    react.useEffect(() => {
        let cancelled = false;
        const poll = () => {
            fetchStatus().then((payload) => {
                if (!cancelled) {
                    setStatus(payload);
                    setStatusError(null);
                }
            }, (error) => {
                if (!cancelled) {
                    setStatusError(errorText(error));
                }
            });
        };
        poll();
        const timer = setInterval(poll, STATUS_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [pollKey]);
    /** Refresh re-runs the immediate poll (vault and schedule mutations call it). */
    const refresh = () => setPollKey((key) => key + 1);
    const state = status?.state ?? 'inactive';
    return (react.createElement("section", { style: CARD_STYLE },
        react.createElement("header", { style: HEADER_STYLE },
            react.createElement("span", null, "Obsidian Mem"),
            renderStateDot(STATE_DOTS[state]),
            renderTag(STATE_TONES[state], state)),
        statusError !== null && (react.createElement("div", { style: WARNING_BANNER_STYLE }, `Memory routes unreachable: ${statusError}`)),
        react.createElement(Section, { title: "Vaults", badge: countBadge(status === null ? null : String(status.vaults.length)), defaultOpen: true },
            react.createElement(VaultsSection, { status: status, refresh: refresh })),
        react.createElement(Section, { title: "Configuration" },
            react.createElement(ConfigurationSection, null)),
        react.createElement(Section, { title: "Index status", defaultOpen: true },
            react.createElement(IndexStatusSection, { status: status, lastBudget: lastBudget })),
        react.createElement(Section, { title: "Audit" },
            react.createElement(AuditSection, { onBudget: setLastBudget })),
        react.createElement(Section, { title: "Dreaming" },
            react.createElement(DreamingSection, { status: status, refresh: refresh })),
        react.createElement(Section, { title: "Search test" },
            react.createElement(SearchSection, null))));
}
function countBadge(text) {
    return text === null ? null : renderTag('quiet', text);
}
function Section(props) {
    return (react.createElement("details", { style: SECTION_STYLE, ...(props.defaultOpen === true ? { defaultOpen: true } : {}) },
        react.createElement("summary", { style: SUMMARY_STYLE },
            react.createElement("span", null, props.title),
            props.badge ?? null),
        react.createElement("div", { style: SECTION_BODY_STYLE }, props.children)));
}
/** RowHint is the shared quiet hint line sections use for empty states. */
export function RowHint({ text }) {
    return react.createElement("div", { style: HINT_STYLE }, text);
}
//# sourceMappingURL=cardRoot.js.map
