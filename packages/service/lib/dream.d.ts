/**
 * The dreaming engine (TASK-035, the service side of `memory_dream`).
 * `plan` is the deterministic candidate analysis sharing the audit
 * engine's note inventory and budget math; `run` launches a dedicated
 * dream agent through the reflection gateway `ctx.get('agents')` only
 * (never a typed import of agents internals), following the engramory-ext
 * §2.6 sequence: single flight armed synchronously before the first await,
 * session `dream-<uuid>`, followup then whenIdle then dispose, and a
 * deterministic post-pass that re-scores relevancy purely from frontmatter
 * read evidence, THEN stamps lastDreamAt (order load-bearing).
 *
 * Git-churn stressors are a documented deviation from the ext: vaults are
 * not necessarily git repos here, so stress is read-staleness, staleness
 * vs lastDreamAt, and near-duplicate vector similarity only. The dream
 * agent moves memory through memory_read/memory_write (service applyWrite);
 * the only files this engine writes are plugin-owned: the editable prompt
 * seed, the state stamp, the relevancy sidecar, and the DREAMS.md diary
 * fallback. Archive candidates are flagged, never auto-deleted.
 * @module dsh-plugin-obsidian-mem/service/dream
 */
import type { VaultMode } from '../../core/lib/index.js';
import type { ResolvedObsidianMemConfig } from './config.js';
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
export declare const DEFAULT_DREAM_PROMPT = "# Obsidian Mem: dreaming protocol\n\nYou are the dreaming agent for the user's shared memory vaults. Work only\nthrough the memory tools: open notes with memory_read, write with\nmemory_write (never raw shell or file tools), and never delete a note:\nretire it by writing it back with archive=true.\n\nGround rules:\n- Resolve contradictions toward the newer, more relevant memory; fold the\n  older information into the surviving note as background.\n- Merge near-duplicate notes: keep the richer note, move every unique fact\n  into it, then archive=true on the others.\n- A note larger than {{NOTE_TIMELINE_BYTES}} bytes is a timeline: keep the\n  conclusion in the note and move the history into a note named after it\n  with the suffix {{ARCHIVE_HISTORY_SUFFIX}} at the vault root (reserved,\n  never indexed).\n- After each step, append a dated section \"## <YYYY-MM-DD> Step <N>: <step\n  name>\" to DREAMS.md in the first shared vault's .obsidian-mem/metadata/\n  directory. The diary is a log: never treat it as a memory source and\n  never write memory notes into it.\n- Never change the frontmatter fields read_count or last_read_at; the\n  plugin scores relevancy deterministically after this run.\n\nSteps, in order:\n1. Post-cognition: for the notes the work plan touches, retitle\n   index_title to the reader's next action in \"Topic: Scenario\" form,\n   tighten index_description to the recall hook that decides whether to\n   open the note, and keep the body settled facts only.\n2. Abstraction: for each surviving note, imagine the future scenario that\n   would need it; correct whatever that scenario exposes as wrong, vague,\n   or stale.\n3. Post-cognition again: repeat step 1; step 2 churned the notes.\n4. Forgetting: for each near-duplicate cluster, merge and archive the\n   losers; for each stale or never-read candidate, verify it and set\n   archive=true when it no longer holds.\n\nGlobal memory injection budget: {{GLOBAL_MEMORY_TOKENS}} tokens.\nNear-duplicate cosine threshold: {{NEAR_DUPLICATE_THRESHOLD}}.\n";
/** One dreaming request; `plan` never calls a model, `run` launches one. */
export interface DreamRequest {
    operation?: 'plan' | 'run';
    /** Per-run model override; empty falls through to config dreaming.model. */
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
/** The reflection-gateway slice of the host `agents` service (never typed). */
export interface DreamAgentsGateway {
    create(options: {
        sessionId: string;
        agentOptions?: {
            model?: string;
        };
    }): Promise<DreamAgentHandle>;
}
export interface DreamAgentHandle {
    agent: {
        followup(message: unknown): unknown;
        whenIdle(): Promise<void>;
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
    /** Stored chunk vectors averaged per note; empty map when index cold. */
    noteVectors: (targets: readonly DreamVectorTarget[]) => Promise<Map<string, number[]>>;
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
    /** Why no run can start at all (no agents gateway); null when ready. */
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
     * ApplyDreamScoring is the deterministic post-pass: relevancy is bumped
     * to the target from frontmatter read evidence newer than the PREVIOUS
     * stamp, tracked-but-unaccessed notes decay one step (floor 0), archive
     * candidates are flagged only, and only THEN is lastDreamAt stamped.
     */
    private applyDreamScoring;
    private setLastDream;
    private readRelevancy;
    private writeRelevancy;
    private seedDreamsDiary;
    private drive;
}
/** RenderPromptTunables substitutes the {{PLACEHOLDER}}s from live config. */
export declare function renderPromptTunables(template: string, config: ResolvedObsidianMemConfig): string;
//# sourceMappingURL=dream.d.ts.map
