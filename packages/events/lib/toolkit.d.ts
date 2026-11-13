/**
 * Toolkit: the plumbing every lifecycle listener assembles the same way,
 * kept in one home instead of per-module copies (mirrors the tools package
 * toolkit): the throw-proof listener wrapper and the fire-and-forget
 * starter, the keyed warn-once sink behind the offline-index discipline,
 * the search-failure log line (offline degrades to one warning when the
 * caller carries a warn-once sink), the once-per-session fresh-source
 * filter shared by the three recall flows (wrapRecalled envelope, content
 * fingerprint, wake terms, all clumped in one FreshSource), the notice
 * injector with token accounting, the one-time provisioning-notice
 * prepend, and the per-source ledger mark.
 *
 * Nothing here decides when a flow fires: the gates stay with their owners
 * (SessionRegistry for budgets, throttles, and the once-per-session rule;
 * each listener for its own cheap filters).
 * @module dsh-plugin-obsidian-mem/events/toolkit
 */
import type { MemorySearchResult } from '../../service/lib/search.js';
import type { HookLogger, LiveAgent } from './host.js';
import { type SessionRegistry } from './sessions.js';
/** RunGuarded runs one listener body; a throw logs and stays contained. */
export declare function runGuarded(logger: HookLogger, label: string, body: () => void): void;
/** FireAndForget starts detached async work; a rejection logs as skipped. */
export declare function fireAndForget(logger: HookLogger, label: string, work: Promise<unknown>): void;
/** WarnOnce is a keyed warning sink: every key logs at most once. */
export type WarnOnce = (key: string, message: string) => void;
/**
 * MakeWarnOnce builds the keyed sink behind the offline-index discipline:
 * a session hammering a dead index gets one warning, then quiet skips.
 */
export declare function makeWarnOnce(logger: HookLogger): WarnOnce;
/**
 * LogSearchFailure logs one failed recall search. With a warn-once sink,
 * the typed offline error degrades to the single `skipped (index offline)`
 * line; everything else (and offline without a sink) logs as skipped.
 */
export declare function logSearchFailure(opts: {
    logger: HookLogger;
    /** Module label opening the line, e.g. `read-intercept`. */
    label: string;
    error: unknown;
    warnOnce?: WarnOnce;
}): void;
/** One recall result that passed the once-per-session filter. */
export interface FreshSource {
    /** Ledger key of the source (sourceKeyFor of the result). */
    key: string;
    /** The wrapRecalled envelope, ready to inject. */
    block: string;
    /** Content fingerprint at injection (the indexed updated_at). */
    fingerprint: string;
    /** Header wake terms this source contributes to the session. */
    terms: string[];
}
/**
 * CollectFreshSources maps the results the session has not already seen
 * (same or unknown fingerprint stays filtered) to FreshSource records, in
 * result order. Callers keep their own gates: budget trimming (turnStart),
 * the per-turn Think shot (thinkIntercept), the Read throttle and cap.
 */
export declare function collectFreshSources(registry: SessionRegistry, sessionId: string, results: readonly MemorySearchResult[]): FreshSource[];
/** MarkSourceInjected records one injected source: fingerprint + wake terms. */
export declare function markSourceInjected(registry: SessionRegistry, sessionId: string, source: FreshSource): void;
/** InjectNotice delivers one notice message and answers its token cost. */
export declare function injectNotice(agent: LiveAgent, id: string, summary: string, blocks: readonly string[]): number;
/** Summary every flow gives the one-time default-vault notice message. */
export declare const PROVISION_NOTICE_SUMMARY = "obsidian-mem: default memory vault provisioned";
/**
 * RetainProvisionNotice stores the notice the flow's ensureMemoryAccess
 * answered in the registry's pending slot (no-op without one), so a later
 * injection skip in this flow (offline index, nothing fresh, spent Think
 * shot) cannot lose it. Every flow calls this right after ensureMemoryAccess
 * and delivers through deliverProvisionNotice at its first real injection.
 */
export declare function retainProvisionNotice(registry: SessionRegistry, notice: string | undefined): void;
/**
 * DeliverProvisionNotice injects the registry's pending default-vault notice,
 * when one waits, as the flow's first message and answers its token cost (0
 * when nothing was pending). Taking clears the slot, so the notice ships
 * exactly once across the turn-start, Read, and Think flows.
 */
export declare function deliverProvisionNotice(agent: LiveAgent, newId: () => string, registry: SessionRegistry): number;
/** MessageIdFactory answers the deps override, else random UUIDs. */
export declare function messageIdFactory(deps: {
    newMessageId?: () => string;
}): () => string;
/**
 * SessionWorkspaceCwd answers the agent's session workspace dir, or null
 * when the header carries none (nothing safe to resolve or scan against).
 */
export declare function sessionWorkspaceCwd(agent: LiveAgent): string | null;
//# sourceMappingURL=toolkit.d.ts.map
