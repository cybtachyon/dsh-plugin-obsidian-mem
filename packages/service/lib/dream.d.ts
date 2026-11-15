/**
 * The dreaming engine (TASK-035, the service side of `memory_dream`).
 * `plan` is the deterministic candidate analysis sharing the audit
 * engine's note inventory and budget math; `run` launches a dedicated
 * dream agent through the reflection gateway `ctx.get('agents')` only
 * (never a typed import of agents internals), following the engramory-ext
 * §2.6 sequence: single flight armed synchronously before the first await,
 * session `dream-<uuid>` created with a resolved provider/model
 * `AgentOptions` (model precedence: per-run override, then config
 * `dreaming.model`, then the host default model; the provider comes only
 * from the host default, so a model override never changes the provider
 * route), followup then whenIdle then a failed-turn scan of the session's
 * own records (agent-loop contains turn errors and whenIdle resolves
 * anyway, so a `turn/end` with `reason.kind === 'error'` throws before the
 * stamp and the post-pass; TASK-003), then dispose, and a deterministic
 * post-pass that re-scores relevancy purely from frontmatter read
 * evidence, THEN stamps lastDreamAt (order load-bearing) and only then
 * fires the optional `onRunSucceeded` dep, the ok-path global-budget
 * rebaseline (PLAN-budget-rebaseline TASK-002).
 *
 * Git (PLAN-git-versioning TASK-006): with config `git.enabled` the shared
 * vaults are git repos owned by the VaultGitManager; the launch text names
 * the adopted roots for the prompt's Step 0 Pre-Sync, the ok path closes
 * with one commitMemory pass over every shared vault, and the Step 4
 * churn stressors read git history at the `git.churnWindowCommits` window.
 * The dream agent moves memory through memory_read/memory_write (service
 * applyWrite); the only files this engine writes are plugin-owned: the
 * editable prompt seed, the state stamp, the relevancy sidecar, and the
 * DREAMS.md diary fallback (gitignored sidecar dir, never committed).
 * Archive candidates are flagged, never auto-deleted.
 * @module dsh-plugin-obsidian-mem/service/dream
 */
import type { VaultMode } from '../../core/lib/index.js';
import type { ResolvedObsidianMemConfig } from './config.js';
import type { VaultGitCommitOutcome } from './vault-git.js';
import type { GlobalBudgetReport, VaultInventory } from './audit.js';
import type { GlobalMemoryIndex, ServiceFs } from './service.js';
/**
 * DEFAULT_DREAM_PROMPT seeds `<dbDir>/dream-prompt.md` once. The seeded
 * file keeps the `{{...}}` tunable placeholders; every load renders them
 * from the CURRENT resolved config, so user edits survive and tunables
 * follow config changes (ext seed-once + render-on-load pattern). It ships
 * as a TS constant because installs carry build output (lib), not source
 * assets.
 */
export declare const DEFAULT_DREAM_PROMPT = "# Obsidian Mem: dreaming protocol\n\nYou are the dreaming agent for the user's shared memory vaults. Work only\nthrough the memory tools: open notes with memory_read, write with\nmemory_write (never raw shell or file tools), and never delete a note:\nretire it by writing it back with archive=true.\n\nGround rules:\n - Resolve contradictions toward the newer, more relevant memory; fold the\n   older information into the surviving note as background.\n - Merge near-duplicate notes: keep the richer note, move every unique fact\n   into it, then archive=true on the others.\n - A note larger than {{NOTE_TIMELINE_BYTES}} bytes is a timeline: keep the\n   conclusion in the note and move the history into a note named after it\n   with the suffix {{ARCHIVE_HISTORY_SUFFIX}} at the vault root (reserved,\n   never indexed).\n - Never change the frontmatter fields read_count or last_read_at; the\n   plugin scores relevancy deterministically after this run.\n - After each step, append a dated section \"## <YYYY-MM-DD> Step <N>: <step\n   name>\" to `DREAMS.md` in the first shared vault's .obsidian-mem/metadata/\n   directory.\n   Use the `read` and `edit` tools ONLY for this file, as it is not a memory.\n   The diary is a plain file log: never treat it as a memory note and\n   never write a memory note into it.\n\n## Step 0: Pre-Sync\n\nSynchronize the memory git repository before touching any memory:\n\n1. Run `git fetch` in the memory root when a remote is configured. When no\n   remote is configured, check the local state alone.\n2. Merge or pull so the branch catches up with its remote. If the merge\n   reports conflicts, resolve every one of them: read both sides and merge\n   the content. Where the two sides disagree and the right merge is\n   ambiguous, preserve both sides in the file rather than picking one.\n3. Re-check until the branch is fully up to date and no unresolved merge\n   remains.\n4. Begin Step 1 only once the store is fully synced. Never edit a memory\n   while a merge is open.\n\n## Step 1: Post-Cognition\n\nLight sleep.\nSort, rewrite, and tidy the store using this process for each file in the\nwork plan below:\n\n1. Re-sort: move data to where it is most relevant. A memory\n   may be coalesced from several files into one, or split apart for cleaner\n   relevancy.\n2. Re-title: each memory index_title phrased as the reader's next action.\n   Write the primary, most-unique verb keyword(s) for the topic, then the\n   remaining relevant title words.\n3. Review: Check memories for contradictions. Resolve cognitive dissonance\n   toward the newer, more relevant information; keep the older information\n   as background. Discard outdated, irrelevant, or dangling references.\n4. Distill: remove fluff language, keeping the core semantic principles and \n   abstract learnings.\n5. Tighten: Rewrite index_description to the recall hook that decides whether to\n   open the note and keep the body settled facts only.\n6. Make presentable: correct run-on sentences into short\n   statements, put line breaks between ideas, use white-space formatting\n   for complex ideas, and turn list-sentences into bulleted lists.\n7. Layer: when one topic holds a large number of memories,\n   place them in a subdirectory and add a topical overview pointer memory\n   that directs the reader to the subdirectory's index. Move archived notes\n   to the `archive` subdirectory.\n\n## Step 2: Cognitive Abstraction\n\nREM sleep.\nPressure-test each memory by simulating its use:\n\n1. Think of the memory in the most abstract manner possible.\n2. Imagine an example scenario that uses the memory together with the\n   memories most likely related to it. Re-add to the abstraction the\n   important details that affect its meaning.\n3. Launch a subagent and ask it to reason about the scenario, providing it\n   only the scenario and the relevant abstracted memories. This is a reasoning\n   task only and must not result in any real change to the file system.\n4. Compare the subagent's result against the original memory for semantic\n   principles and learnings.\n5. Correct whatever that scenario exposes as wrong, vague, or stale, then\n   ensure the memory note covers lessons learned.\n\n## Step 3: Post-Cognition Re-run\n\nPost-cognition again: repeat step 1; step 2 churned the notes.\n\n## Step 4: Long-Term Memory, Bias, and Forgetting\n\nDeep sleep.\nSettle relevancy, surface stressors, and forget on purpose:\n\n1. Identify stressors: memories with high relevancy and consistent churn.\n   From git history, a stressor is a file edited in over\n   {{CHURN_THRESHOLD_PERCENT}}% of the last {{CHURN_WINDOW_COMMITS}}\n   commits. Annotate each stressor with a set of investigative questions\n   oriented toward reducing its future churn, and instruct future agents\n   to resolve them at the next memory edit.\n2. For each near-duplicate cluster, merge and archive the losers;\n   for each stale or never-read candidate, verify it and set archive=true when \n   it no longer holds.\n\nGlobal memory injection budget: {{GLOBAL_MEMORY_TOKENS}} tokens.\nNear-duplicate cosine threshold: {{NEAR_DUPLICATE_THRESHOLD}}.\n\nHere is the work plan for Step 1:\n";
/** One dreaming request; `plan` never calls a model, `run` launches one. */
export interface DreamRequest {
    operation?: 'plan' | 'run';
    /**
     * Per-run model override; empty counts as unset and falls through to
     * config dreaming.model, then the host default model. It never changes
     * the provider route, which only the host default supplies.
     */
    model?: string;
}
/** A note the plan proposes work for. */
export interface DreamCandidate {
    path: string;
    vaultPath: string;
    /** Vault-relative posix path: the vector lookup key (source_path). */
    rel: string;
    mode: VaultMode;
    reasons: string[];
    readCount: number;
    lastReadAt: string;
    sizeBytes: number;
}
/** The deterministic plan: prompt, ranked work, clusters, budget math. */
export interface DreamPlan {
    generatedAt: number;
    lastDreamAt: number | null;
    /** Current editable prompt, tunables rendered (what a run would send). */
    prompt: string;
    /** Numbered work plan text (also the run message's work section). */
    plan: string;
    candidates: DreamCandidate[];
    clusters: string[][];
    stats: {
        notes: number;
        globalNotes: number;
        oversized: number;
        staleOrUnread: number;
        totalBytes: number;
    };
    budget: GlobalBudgetReport;
    skipped: string[];
}
/** What one completed (or failed) run recorded for status and audit. */
export interface DreamRunSummary {
    id: string;
    startedAt: number;
    finishedAt: number;
    ok: boolean;
    notes: number;
    bumped: number;
    degraded: number;
    /** Flagged for the next review; the engine never archives by itself. */
    archiveCandidates: string[];
    /** One-line outcome, diary and status appropriate. */
    summary: string;
    error: string | null;
}
/** The immediate answer of a launched run; attach a swallowing catch. */
export interface DreamRunHandle {
    id: string;
    done: Promise<DreamRunSummary>;
}
/** The seam answer for any dream request, discriminated by operation. */
export type DreamEngineResult = {
    operation: 'plan';
    plan: DreamPlan;
} | {
    operation: 'run';
    id: string;
    done: Promise<DreamRunSummary>;
};
/** Thrown when a second run arrives while one is in flight. */
export declare class DreamBusyError extends Error {
    constructor(message: string);
}
/** Thrown when no agents service exists to host the dream agent. */
export declare class DreamBlockedError extends Error {
    constructor(message: string);
}
/**
 * DreamAgentRoute is the provider/model pair that travels together from the
 * host default selection, through the launch resolver, into
 * `agents.create`. Either half may be unresolved until the pair is complete.
 */
export interface DreamAgentRoute {
    provider?: string;
    model?: string;
}
/** The reflection-gateway slice of the host `agents` service (never typed). */
export interface DreamAgentsGateway {
    create(options: {
        sessionId: string;
        agentOptions?: DreamAgentRoute;
        /**
         * Durable session metadata forwarded unchanged to
         * `sessions.create().meta`: the validated absolute `cwd` decides the
         * persisted transcript bucket and is what makes the session
         * GUI-addressable (PLAN-dream-meta-cwd).
         */
        meta?: {
            cwd?: string;
        };
        /**
         * Creation-time composition of the agent's scoped world before
         * publication (PLAN-dream-isolation TASK-002, the 0.2.1-alpha.3
         * `CreateAgentOptions.setup` seam): everything registered through
         * the agent context exists before the first prompt assembly.
         * Forwarded unchanged; a gateway that ignores the option launches
         * exactly as before (it is additive).
         */
        setup?: (agentCtx: DreamAgentPromptScope) => void;
    }): Promise<DreamAgentHandle>;
}
/**
 * DreamAgentPromptScope is the local structural mirror of the agent-context
 * slice the launch `setup` composes (never a typed agents import). In the
 * host contract, `section()` registers in the calling context's scope, a
 * `complete: true` section makes prompt assembly restore that exact
 * section as the SOLE prompt section, and `suppressRuntimeContext()`
 * removes the optional dynamic runtime-context contributions of that
 * scope. Every member is optional here because the seam may be absent at
 * runtime, and the setup guards each hop.
 */
export interface DreamAgentPromptScope {
    systemPrompt?: {
        section(options: {
            name: string;
            order: number;
            interpolate?: boolean;
            complete?: boolean;
            text: string;
        }): unknown;
        suppressRuntimeContext?(): unknown;
    };
}
/**
 * DreamPromptIsolationSetup returns the `setup` callback `drive()` passes
 * to `agents.create`: it registers the empty complete system-prompt
 * section in the dream agent's own scope and calls `suppressRuntimeContext()`
 * when the seam answers it, so the dream session carries no deployment
 * persona, no tool guidance, and no session runtime context. Its whole
 * session context is the launch text (dream-prompt.md plus the work
 * plan). Every hop is guarded structurally: the seam may be absent on a
 * host that predates it, and a missing seam must never throw out of
 * setup, where a throw would fail the launch itself.
 */
export declare function dreamPromptIsolationSetup(): (agentCtx: DreamAgentPromptScope) => void;
/**
 * The reflection-gateway slice of the host `agentDefaultModel` service
 * (never typed; TASK-002 wiring). The structural shape matches the
 * `dsh-headless` `ctx.get("agentDefaultModel").currentSelection():
 * ModelSelection` (a live selection always answers both halves; the optional
 * fields let the resolver treat a partial answer as unresolved).
 */
export interface DreamDefaultModelGateway {
    currentSelection(): DreamAgentRoute;
}
export interface DreamAgentHandle {
    agent: {
        followup(message: unknown): unknown;
        whenIdle(): Promise<void>;
        /**
         * Structural slice of the live agent's `readonly session: Session`
         * (`@deepseek-ai/dsh-agent` runtime-types): `ownEvents()` returns this
         * session's records. Declared optional because the runtime may not
         * carry it; a missing slice logs a warning, never a silent pass
         * (dream-launch TASK-003). `ownEvents()` is `@deprecated` in the
         * installed `@deepseek-ai/dsh-session` (0.2.1-alpha.3), like every
         * synchronous session-event read there, and no non-deprecated
         * same-scope read exists; a host removal lands here as the
         * missing-slice warning (dream-launch TASK-005 adjudication).
         */
        session?: {
            ownEvents(): readonly {
                type: string;
                data?: unknown;
            }[];
        };
    };
    dispose(): Promise<void> | void;
}
/** A note the plan needs stored vectors for, keyed by absolute path. */
export interface DreamVectorTarget {
    path: string;
    vaultPath: string;
    rel: string;
}
/** Everything external is injected: no os, no cordis imports in the class. */
export interface DreamDeps {
    /** Plugin-owned file writes (prompt seed, stamp, sidecar, diary). */
    fs: ServiceFs;
    config: ResolvedObsidianMemConfig;
    /** Live note inventories from the audit enumeration (read-only seam). */
    inventories: () => VaultInventory[];
    globalIndex: () => GlobalMemoryIndex & {
        overBudget?: boolean;
    };
    /** Reflection gateway: undefined until an agents service mounts. */
    agentsGateway: () => DreamAgentsGateway | undefined;
    /**
     * Host default provider/model route for spawned agents; undefined when
     * the host offers no default-model service. It is the only provider
     * source: model overrides never change the provider route.
     */
    defaultAgentOptions: () => DreamAgentRoute | undefined;
    /** Stored chunk vectors averaged per note; empty map when index cold. */
    noteVectors: (targets: readonly DreamVectorTarget[]) => Promise<Map<string, number[]>>;
    /**
     * CommitMemory records one git commit pass over every shared vault at
     * the end of the ok path (the service wires the VaultGitManager
     * commitAllShared seam; a disabled git gate answers the empty list). A
     * null hash means the vault tree was clean. The orchestrator catches
     * throws: git is the history book and can never flip a landed memory
     * run (PLAN-git-versioning TASK-006).
     */
    commitMemory: (message: string) => Promise<VaultGitCommitOutcome[]>;
    /**
     * GitRoots lists the shared vault roots the git layer has adopted; the
     * launch text names them for the prompt's Step 0 Pre-Sync step only
     * when the list is non-empty (empty means git is off or nothing is
     * adopted yet).
     */
    gitRoots: () => string[];
    /**
     * Fires on the ok path only, right after the lastDreamAt stamp: the
     * service wires it to the session registry's budget reset, so a
     * successful compaction rebaselines the global recall window
     * (PLAN-budget-rebaseline TASK-002). A failed run, a busy or blocked
     * throw, and `plan` never reach it.
     */
    onRunSucceeded?: () => void;
    log: (message: string) => void;
}
/**
 * DreamOrchestrator holds the ONE single-flight guard that converges the
 * tool, the settings-card button, and scheduled triggers (ext §2.6): the
 * state is armed synchronously before the first await of a run, so two
 * concurrent run requests cannot both slip through.
 */
export declare class DreamOrchestrator {
    private readonly deps;
    private state;
    private lastSummaryValue;
    constructor(deps: DreamDeps);
    /** The summary of the most recent run, or null before the first. */
    get lastSummary(): DreamRunSummary | null;
    /** True while a run owns the guard. */
    get busy(): boolean;
    /**
     * Why no run can start at all (no agents gateway, or no provider/model
     * pair resolves from config plus the host default); null when ready.
     * The status-facing gate resolves without a per-run override (there is
     * no run at status time); drive re-checks the pair at launch with the
     * run's own override.
     */
    blockedReason(): string | null;
    /** Absolute path of the editable dream prompt (seeded on first use). */
    promptPath(): string;
    /** Editable prompt file content with tunables rendered for this config. */
    loadPrompt(): string;
    /** Last dream stamp (<dbDir>/state/state.json), null when never. */
    lastDreamAt(): number | null;
    /**
     * Plan is the deterministic analysis (no model call): ranked candidates
     * from read-staleness and bloat heuristics, near-duplicate clusters from
     * stored vectors when the index answers, and the global budget section
     * with its headroom math.
     */
    plan(): Promise<DreamPlan>;
    /**
     * StartRun arms the single-flight guard synchronously (before the first
     * await) and returns the {id, done} pair immediately; the caller attaches
     * a swallowing logging catch to done and never awaits it inline. `done`
     * rejects when the run failed; the summary is recorded either way.
     */
    startRun(options?: {
        model?: string;
    }): DreamRunHandle;
    private nearDuplicateThreshold;
    /**
     * LaunchRoute is the single home of the launch model rule: the
     * model is the first non-empty of the per-run override, config
     * dreaming.model, and the host default model (empty string counts as
     * unset); the provider comes only from the host default selection, so
     * model overrides never change the provider route. Returns the complete
     * provider/model pair, or null when either half is unresolved;
     * blockedReason and drive read the pair from here and nowhere else.
     */
    private launchRoute;
    /**
     * ApplyDreamScoring is the deterministic post-pass: relevancy is bumped
     * to the target from frontmatter read evidence newer than the PREVIOUS
     * stamp, tracked-but-unaccessed notes decay one step (floor 0), archive
     * candidates are flagged only, and only THEN is lastDreamAt stamped.
     */
    private applyDreamScoring;
    private setLastDream;
    private relevancyPath;
    private readRelevancy;
    private writeRelevancy;
    private seedDreamsDiary;
    private assertNoFailedTurn;
    private drive;
}
/** RenderPromptTunables substitutes the {{PLACEHOLDER}}s from live config. */
export declare function renderPromptTunables(template: string, config: ResolvedObsidianMemConfig): string;
//# sourceMappingURL=dream.d.ts.map
