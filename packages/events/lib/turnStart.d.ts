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
import type { ManifestFs, WorkspaceManifest } from '../../core/lib/index.js';
import type { HookLogger, LiveAgent, MemoryEventsService } from './host.js';
import { type SessionRegistry } from './sessions.js';
/** Node ManifestFs over sync fs reads; unreadable paths answer null (skip). */
export declare const nodeManifestFs: ManifestFs;
/** Constructor dependencies; `manifestFs` and `newMessageId` are test seams. */
export interface TurnStartDeps {
    agent: LiveAgent;
    memory: MemoryEventsService;
    registry: SessionRegistry;
    logger: HookLogger;
    manifestFs?: ManifestFs;
    newMessageId?: () => string;
}
/**
 * InstallTurnStart registers the per-agent `agent/pre-step` observer and
 * answers its disposer (the caller keeps it in the plugin's own effect per
 * AGENTS.md Event Facts). The registration itself happens on the agent's
 * context, inside the caller's `agent.ctx.effect()`.
 */
export declare function installTurnStart(deps: TurnStartDeps): () => void;
/** GuidanceLine names the discovered file types, languages, frameworks. */
export declare function guidanceLine(manifest: WorkspaceManifest): string;
//# sourceMappingURL=turnStart.d.ts.map
