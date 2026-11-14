/**
 * LlmRefiner runs the optional Q3 pass over the core heuristics: one
 * OpenAI-compatible chat completion per chunk asking for extra
 * wake_keywords and trigger_frameworks, merged onto (never replacing) what
 * extractTriggers already found. Endpoint wake terms re-pass core's
 * isUsableKeyword and both merged lists re-pass core's capColumn; the
 * endpoint is an advisor, never a second legality home.
 *
 * It is an upgrade path, never a dependency: absent config, a missing API
 * key, a bad status, or unparseable JSON all fall back to the heuristics
 * silently while the failure counter feeds the ui status and audit. Three
 * consecutive failures open the circuit for the rest of the run, so an
 * offline endpoint cannot add a timeout to every chunk (indexer.ts resets
 * the circuit at each run boundary).
 * @module dsh-plugin-obsidian-mem/service/llm-refine
 */
import type { Triggers } from '../../core/lib/index.js';
/** Chat-completion config; Q3's optional LLM upgrade over the heuristics. */
export interface LlmRefineConfig {
    enabled: boolean;
    /** OpenAI-compatible base URL; the pass POSTs `<baseUrl>/chat/completions`. */
    baseUrl: string;
    model: string;
    /** Env var NAME holding the bearer key; unset means no auth header. */
    apiKeyEnv?: string;
}
/** Fetch-slice the LLM pass calls; tests inject a fake, Node 22 fetch fits. */
export type LlmFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
}) => Promise<{
    status?: number;
    ok?: boolean;
    json(): Promise<unknown>;
}>;
/** Constructor options for one LlmRefiner; every external touch is injected. */
export interface LlmRefinerOptions {
    /** Absent or disabled means the pass never runs and never counts. */
    config?: LlmRefineConfig;
    /** Fetch seam; defaults to the process-global fetch (Node 18+). Only a runtime without a global fetch keeps the pass inert. */
    fetch?: LlmFetch;
    /** Env for the api-key lookup; default process.env. */
    env?: Record<string, string | undefined>;
    /** Loud lines (circuit opening); default console.warn. */
    log?: (message: string) => void;
}
/**
 * LlmRefiner holds the pass's own state (the failure counter plus the
 * per-run circuit) so the indexer keeps indexing regardless of what the
 * endpoint does. Constructing runs nothing.
 */
export declare class LlmRefiner {
    private readonly config;
    private readonly fetchImpl;
    private readonly env;
    private readonly log;
    private consecutiveFailures;
    private circuitOpen;
    private failureCount;
    constructor(options?: LlmRefinerOptions);
    /** Failures counts every rejected refinement since construction. */
    get failures(): number;
    /**
     * ResetRun closes the circuit and the consecutive counter at the start of
     * an indexing run, so an endpoint that came back between runs gets retried.
     */
    resetRun(): void;
    /**
     * Refine merges the endpoint's wake_keywords and trigger_frameworks onto
     * the heuristic lists, heuristic-first and deduped. Endpoint wake terms
     * pass core's isUsableKeyword legality (the one gate), and both merged
     * lists re-run core's capColumn, so an endpoint can never inject generic
     * or fragment vocabulary nor overflow an Array column's capacity. It
     * returns `base` unchanged whenever the pass is off, unconfigured, or
     * failing.
     */
    refine(chunkText: string, base: Triggers): Promise<Triggers>;
    private fetchReply;
}
//# sourceMappingURL=llm-refine.d.ts.map
