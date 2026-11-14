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
import { capColumn, isUsableKeyword } from '../../core/lib/index.js';
import { describeError } from './errors.js';
// Chars of chunk text pasted into one prompt.
const LLM_INPUT_CHAR_CAP = 6000;
// Consecutive failures that open the circuit for the rest of the run.
const LLM_FAILURE_CIRCUIT = 3;
const LLM_REQUEST_TIMEOUT_MS = 15_000;
/**
 * LlmRefiner holds the pass's own state (the failure counter plus the
 * per-run circuit) so the indexer keeps indexing regardless of what the
 * endpoint does. Constructing runs nothing.
 */
export class LlmRefiner {
    config;
    fetchImpl;
    env;
    log;
    consecutiveFailures = 0;
    circuitOpen = false;
    failureCount = 0;
    constructor(options = {}) {
        this.config = options.config ?? { enabled: false, baseUrl: '', model: '' };
        // The production call seam defaults here, like env and log below: the
        // service mounts the indexer with config only, and a pass that waited
        // for someone to hand it a fetch silently never ran (found 2026-11-13
        // enabling the basalt endpoint). Resolved through globalThis at call
        // time, so tests can stub the global.
        this.fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function'
            ? (url, init) => globalThis.fetch(url, init)
            : null);
        this.env = options.env ?? process.env;
        this.log = options.log ?? ((message) => console.warn(`[obsidian-mem llm] ${message}`));
    }
    /** Failures counts every rejected refinement since construction. */
    get failures() {
        return this.failureCount;
    }
    /**
     * ResetRun closes the circuit and the consecutive counter at the start of
     * an indexing run, so an endpoint that came back between runs gets retried.
     */
    resetRun() {
        this.consecutiveFailures = 0;
        this.circuitOpen = false;
    }
    /**
     * Refine merges the endpoint's wake_keywords and trigger_frameworks onto
     * the heuristic lists, heuristic-first and deduped. Endpoint wake terms
     * pass core's isUsableKeyword legality (the one gate), and both merged
     * lists re-run core's capColumn, so an endpoint can never inject generic
     * or fragment vocabulary nor overflow an Array column's capacity. It
     * returns `base` unchanged whenever the pass is off, unconfigured, or
     * failing.
     */
    async refine(chunkText, base) {
        const fetchImpl = this.fetchImpl;
        if (!this.config.enabled || fetchImpl === null || this.circuitOpen) {
            return base;
        }
        const apiKey = this.config.apiKeyEnv !== undefined ? this.env[this.config.apiKeyEnv] : '';
        if (this.config.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === '')) {
            return base;
        }
        try {
            const payload = await this.fetchReply(fetchImpl, chunkText, apiKey);
            const parsed = parseReply(payload);
            this.consecutiveFailures = 0;
            return {
                ...base,
                wake_keywords: capColumn(
                // Legality reads the normalized form mergeLists will store, so a
                // padded or title-case term is judged as its stored lowercase form.
                mergeLists(base.wake_keywords, stringEntries(parsed.wake_keywords)
                    .map((value) => value.trim().toLowerCase())
                    .filter(isUsableKeyword)), 'wakeKeywords'),
                trigger_frameworks: capColumn(mergeLists(base.trigger_frameworks, stringEntries(parsed.trigger_frameworks)), 'triggerFrameworks'),
            };
        }
        catch (error) {
            this.failureCount += 1;
            this.consecutiveFailures += 1;
            if (this.consecutiveFailures >= LLM_FAILURE_CIRCUIT && !this.circuitOpen) {
                this.circuitOpen = true;
                this.log(`llm refinement disabled for this run after ${this.consecutiveFailures} `
                    + `consecutive failures: ${describeError(error)}`);
            }
            return base;
        }
    }
    // fetchImpl and apiKey arrive resolved from refine's guards: a private
    // field is not narrowed across a method boundary, and passing what the
    // guard already proved keeps the null check in one place.
    async fetchReply(fetchImpl, chunkText, apiKey) {
        const response = await fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(apiKey !== undefined && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: [{ role: 'user', content: refinePrompt(chunkText) }],
                temperature: 0,
            }),
            ...(typeof AbortSignal.timeout === 'function'
                ? { signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS) }
                : {}),
        });
        if (response.ok === false || (response.ok === undefined && (response.status ?? 0) >= 400)) {
            throw new Error(`llm status ${String(response.status ?? 'unknown')}`);
        }
        return await response.json();
    }
}
/** RefinePrompt builds the single user message asking for the JSON shape. */
function refinePrompt(chunkText) {
    return 'Extract wake keywords and frameworks for this memory note chunk. '
        + 'Reply with ONLY a JSON object of the shape '
        + '{"wake_keywords": ["...", "..."], "trigger_frameworks": ["...", "..."]}. '
        + 'Lowercase terms only.\n\n---\n'
        + chunkText.slice(0, LLM_INPUT_CHAR_CAP);
}
// Pulls the JSON out of the chat reply: the message content, with a
// ```json fence stripped when a model wraps it. A missing content string is
// a failure, not an empty refinement.
function parseReply(payload) {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new Error('llm response has no message content');
    }
    const jsonText = content
        .replace(/^```(?:json)?[ \t]*\n?/i, '')
        .replace(/```[ \t]*$/, '')
        .trim();
    return JSON.parse(jsonText);
}
// Heuristic-first merge, deduped; endpoint values are trimmed and lowercased
// so casing differences never add a second copy of one term.
function mergeLists(base, extra) {
    return [...new Set([
            ...base,
            ...extra.map((value) => value.trim().toLowerCase()).filter((value) => value !== ''),
        ])];
}
function stringEntries(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === 'string');
}
//# sourceMappingURL=llm-refine.js.map
