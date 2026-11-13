/**
 * Turn-start recall injection (TASK-041). The listener rides
 * `agent/pre-step` (there is no turn/start event): registered on the
 * AGENT's own context from the plugin's `agent/created` handler (AGENTS.md
 * "DSH Event Facts"), it fires the flow once per session at the first step
 * the session is first seen at. The waterfall discipline is absolute: every
 * path through the handler ends in `await next()` with the decision spread,
 * so this listener can never reject or reshape a step, and all recall work
 * is fire-and-forget (`agent.inject()` lands the context at the next step
 * boundary without waking the agent; blocking the waterfall behind a
 * cold-starting index would stall the loop).
 *
 * The flow: ensureMemoryAccess (the one-time default-vault notice is
 * injected first), TASK-045's budget switch (an over-budget session is
 * suppressed: nothing below runs and the flow returns early; the compaction
 * reminder rides the turn-end steer instead), TASK-014's pinned injection
 * of each shared vault's global memory file within the remaining global
 * budget, one workspace manifest scan at
 * the agent's session cwd, search over the first user text alone (the
 * manifest text feeds only the guidance line; the TASK-015 A/B measured
 * its contamination of both search routes), budget trimming to
 * `budgets.turnStartRecallTokens`, the
 * once-per-session source filter, `core.wrapRecalled` envelopes (defang
 * included), the memory_search guidance line naming the discovered
 * extensions/languages/frameworks, the token accounting TASK-045 consumes,
 * and the once-per-session mark that keeps a pinned global file out of the
 * search recall below.
 * @module dsh-plugin-obsidian-mem/events/turnStart
 */
import { readdirSync, readFileSync } from 'node:fs';
import { approxCharsForTokens, approxTokens, isOverGlobalBudget, scanManifest, wrapRecalled } from '../../core/lib/index.js';
import { describeError } from '../../service/lib/errors.js';
import { firstUserText } from './host.js';
import { sourceKeyFor } from './sessions.js';
import { collectFreshSources, deliverProvisionNotice, fireAndForget, injectNotice, logSearchFailure, markSourceInjected, messageIdFactory, retainProvisionNotice, runGuarded, sessionWorkspaceCwd, } from './toolkit.js';
/** Node ManifestFs over sync fs reads; unreadable paths answer null (skip). */
export const nodeManifestFs = {
    listDirectory(path) {
        try {
            return readdirSync(path, { withFileTypes: true })
                .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
        }
        catch {
            return null;
        }
    },
    readFile(path) {
        try {
            return readFileSync(path, 'utf8');
        }
        catch {
            return null;
        }
    },
};
/**
 * InstallTurnStart registers the per-agent `agent/pre-step` observer and
 * answers its disposer (the caller keeps it in the plugin's own effect per
 * AGENTS.md Event Facts). The registration itself happens on the agent's
 * context, inside the caller's `agent.ctx.effect()`.
 */
export function installTurnStart(deps) {
    const listener = async (payload, next) => {
        // Observation only: a broken recall gate never touches the decision.
        runGuarded(deps.logger, 'turn-start recall gate', () => {
            claimTurnStart(deps, payload);
        });
        const decision = await next();
        return { ...decision };
    };
    const off = deps.agent.ctx.on('agent/pre-step', listener);
    return () => { off(); };
}
// Synchronous claim: per-turn bookkeeping, then the once-per-session slot.
// Marking done BEFORE the async work prevents a second step from starting a
// parallel recall while the first is still searching. The payload travels
// whole; its agent/turn/step/messages fields are a group in every use here.
function claimTurnStart(deps, payload) {
    const sessionId = String(payload.agent.id);
    // The first user text rides into the registry for TASK-044's trivial-turn
    // guard (the turn-stopping payload carries no messages).
    deps.registry.noteTurn(sessionId, payload.turn, firstUserText(payload.messages));
    if (payload.step !== 1 || deps.registry.isTurnStartDone(sessionId)) {
        return;
    }
    deps.registry.markTurnStartDone(sessionId);
    fireAndForget(deps.logger, 'turn-start recall', runTurnStartRecall(deps, sessionId, payload.messages));
}
/** RunTurnStartRecall is the whole once-per-session flow, errors contained. */
async function runTurnStartRecall(deps, sessionId, messages) {
    const { memory, registry } = deps;
    const newId = messageIdFactory(deps);
    let injectedTokens = 0;
    // Step 0: lazy provisioning; the trigger call answers the one-time
    // default-vault notice, which reads first, exactly once. The notice sits
    // in the registry's pending slot until a flow injects it (TASK-046
    // carry-over: a skip here must not swallow it).
    retainProvisionNotice(registry, await memory.ensureMemoryAccess());
    injectedTokens += deliverProvisionNotice(deps.agent, newId, registry);
    // TASK-045: the global memory budget. While the summed recall injections
    // since the last successful dream or host restart sit past
    // `budgets.globalMemoryTokens`, fresh recall is suppressed; the compaction
    // reminder moved to the turn-end steer (TASK-003), and the audit's
    // budget.over line still names the remedy with the same numbers.
    const budgetTokens = memory.config.budgets.globalMemoryTokens;
    if (isOverGlobalBudget(registry.totalRecallTokensUsed(), budgetTokens)) {
        registry.addRecallTokens(sessionId, injectedTokens);
        return;
    }
    // TASK-014: pinned session-start injection of each shared vault's global
    // memory file, inside the remaining global budget.
    injectedTokens += injectPinnedGlobalMemory(deps, sessionId, newId, budgetTokens);
    // Step 1: one manifest scan for the session, at the agent's workspace.
    const cwd = sessionWorkspaceCwd(deps.agent);
    const manifest = cwd === null
        ? null
        : scanManifestSafe(cwd, deps.manifestFs ?? nodeManifestFs, deps.logger);
    // Steps 2-3: search the first user text alone, budget-fit trim. The
    // manifest text stays out of the query: the TASK-015 A/B
    // (docs/PLAN-milvus-tuning-TASK-015-manifest-text-ab.md) measured its
    // token soup pulling generic-process notes into the dual-route band
    // and displacing in-domain rows (P@6 0.417 vs 0.267). The manifest
    // still feeds the guidance line below, unchanged.
    const kept = await budgetedRecallSources(deps, sessionId, firstUserText(messages));
    // Recall bodies first, so the guidance line reads last.
    for (const item of kept) {
        injectedTokens += injectNotice(deps.agent, newId(), 'obsidian-mem: turn-start recall', [item.block]);
        markSourceInjected(registry, sessionId, item);
    }
    if (manifest !== null) {
        const guidance = guidanceLine(manifest);
        if (guidance !== '') {
            injectedTokens += injectNotice(deps.agent, newId(), 'obsidian-mem: memory_search guidance', [guidance]);
        }
    }
    // TASK-045's global budget counts every token this flow injected.
    registry.addRecallTokens(sessionId, injectedTokens);
}
// BudgetedRecallSources answers the search-recall blocks to inject:
// search the query at the turn-start searchTopK, drop sources this
// session already injected, then keep blocks while they fit the
// turnStartRecallTokens budget. A failed search is logged and answers
// empty; an empty query (a session opening on non-text) searches
// nothing.
async function budgetedRecallSources(deps, sessionId, query) {
    if (query === '') {
        return [];
    }
    let results;
    try {
        results = await deps.memory.search({ query, topK: deps.memory.config.budgets.searchTopK });
    }
    catch (error) {
        logSearchFailure({ logger: deps.logger, label: 'turn-start recall', error });
        results = [];
    }
    const kept = [];
    let used = 0;
    for (const item of collectFreshSources(deps.registry, sessionId, results)) {
        const cost = approxTokens(item.block);
        if (used + cost > deps.memory.config.budgets.turnStartRecallTokens) {
            break;
        }
        used += cost;
        kept.push(item);
    }
    return kept;
}
/**
 * InjectPinnedGlobalMemory injects each shared vault's global memory file
 * (TASK-014) clamped to the remaining global budget, marks every injected
 * source, and answers the injected token total for the flow's accounting.
 * The sources are read even when nothing is left in the budget (the
 * strictly-over gate returned earlier; consulting the service is side-
 * effect free, and the at-cap session still consults it). The cap is
 * loop-invariant because this flow's own usage reaches the registry only
 * through the flow-total below, so every pinned file is clamped to the same
 * remaining budget. The source mark is fingerprint-less on purpose: that is
 * the registry's session-wide block form, and the search recall in the flow
 * below computes its fingerprint from the indexed updated_at, which the raw
 * file read here cannot know.
 */
function injectPinnedGlobalMemory(deps, sessionId, newId, budgetTokens) {
    const sources = deps.memory.globalMemorySources();
    const remainingTokens = budgetTokens - deps.registry.totalRecallTokensUsed();
    if (remainingTokens <= 0) {
        return 0;
    }
    const cap = approxCharsForTokens(remainingTokens);
    let injectedTokens = 0;
    for (const source of sources) {
        const body = source.content.length > cap ? source.content.slice(0, cap) : source.content;
        injectedTokens += injectNotice(deps.agent, newId(), 'obsidian-mem: pinned global memory', [wrapRecalled(source.path, body)]);
        deps.registry.markInjected(sessionId, sourceKeyFor({ vault: source.vaultPath, source_path: source.path }));
    }
    return injectedTokens;
}
/** GuidanceLine names the discovered file types, languages, frameworks. */
export function guidanceLine(manifest) {
    const discovered = [
        ...manifest.topExtensions.map((extension) => `.${extension}`),
        ...manifest.languages,
        ...manifest.frameworks,
    ].filter((value, index, all) => all.indexOf(value) === index);
    if (discovered.length === 0) {
        return '';
    }
    return 'Use memory_search for the file types, coding languages, or frameworks '
        + `you discover in this workspace: ${discovered.join(', ')}.`;
}
/** ScanManifestSafe bounds one workspace walk; a broken tree answers null. */
function scanManifestSafe(cwd, fsLike, logger) {
    try {
        return scanManifest(cwd, fsLike);
    }
    catch (error) {
        logger.warn(`workspace manifest scan failed (skipped): ${describeError(error)}`);
        return null;
    }
}
//# sourceMappingURL=turnStart.js.map
