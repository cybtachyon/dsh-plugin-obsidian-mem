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

import type { Triggers } from '../../core/lib/index.js'

import { capColumn, isUsableKeyword } from '../../core/lib/index.js'
import { describeError } from './errors.js'

/** Chat-completion config; Q3's optional LLM upgrade over the heuristics. */
export interface LlmRefineConfig {
  enabled: boolean
  /** OpenAI-compatible base URL; the pass POSTs `<baseUrl>/chat/completions`. */
  baseUrl: string
  model: string
  /** Env var NAME holding the bearer key; unset means no auth header. */
  apiKeyEnv?: string
}

/** Fetch-slice the LLM pass calls; tests inject a fake, Node 22 fetch fits. */
export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status?: number; ok?: boolean; json(): Promise<unknown> }>

/** Constructor options for one LlmRefiner; every external touch is injected. */
export interface LlmRefinerOptions {
  /** Absent or disabled means the pass never runs and never counts. */
  config?: LlmRefineConfig
  /** Fetch seam; absent means the pass never runs. */
  fetch?: LlmFetch
  /** Env for the api-key lookup; default process.env. */
  env?: Record<string, string | undefined>
  /** Loud lines (circuit opening); default console.warn. */
  log?: (message: string) => void
}

/** The two keyword lists a chat reply may add to. */
interface ReplyKeywords {
  wake_keywords?: unknown
  trigger_frameworks?: unknown
}

// Chars of chunk text pasted into one prompt.
const LLM_INPUT_CHAR_CAP = 6000
// Consecutive failures that open the circuit for the rest of the run.
const LLM_FAILURE_CIRCUIT = 3
const LLM_REQUEST_TIMEOUT_MS = 15_000

/**
 * LlmRefiner holds the pass's own state (the failure counter plus the
 * per-run circuit) so the indexer keeps indexing regardless of what the
 * endpoint does. Constructing runs nothing.
 */
export class LlmRefiner {
  private readonly config: LlmRefineConfig
  private readonly fetchImpl: LlmFetch | null
  private readonly env: Record<string, string | undefined>
  private readonly log: (message: string) => void

  private consecutiveFailures = 0
  private circuitOpen = false
  private failureCount = 0

  constructor(options: LlmRefinerOptions = {}) {
    this.config = options.config ?? { enabled: false, baseUrl: '', model: '' }
    this.fetchImpl = options.fetch ?? null
    this.env = options.env ?? process.env
    this.log = options.log ?? ((message) => console.warn(`[obsidian-mem llm] ${message}`))
  }

  /** Failures counts every rejected refinement since construction. */
  get failures(): number {
    return this.failureCount
  }

  /**
   * ResetRun closes the circuit and the consecutive counter at the start of
   * an indexing run, so an endpoint that came back between runs gets retried.
   */
  resetRun(): void {
    this.consecutiveFailures = 0
    this.circuitOpen = false
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
  async refine(chunkText: string, base: Triggers): Promise<Triggers> {
    const fetchImpl = this.fetchImpl
    if (!this.config.enabled || fetchImpl === null || this.circuitOpen) {
      return base
    }
    const apiKey = this.config.apiKeyEnv !== undefined ? this.env[this.config.apiKeyEnv] : ''
    if (this.config.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === '')) {
      return base
    }

    try {
      const payload = await this.fetchReply(fetchImpl, chunkText, apiKey)
      const parsed = parseReply(payload)
      this.consecutiveFailures = 0
      return {
        ...base,
        wake_keywords: capColumn(
          // Legality reads the normalized form mergeLists will store, so a
          // padded or title-case term is judged as its stored lowercase form.
          mergeLists(base.wake_keywords, stringEntries(parsed.wake_keywords)
            .map((value) => value.trim().toLowerCase())
            .filter(isUsableKeyword)),
          'wakeKeywords',
        ),
        trigger_frameworks: capColumn(
          mergeLists(base.trigger_frameworks, stringEntries(parsed.trigger_frameworks)),
          'triggerFrameworks',
        ),
      }
    } catch (error) {
      this.failureCount += 1
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= LLM_FAILURE_CIRCUIT && !this.circuitOpen) {
        this.circuitOpen = true
        this.log(`llm refinement disabled for this run after ${this.consecutiveFailures} `
          + `consecutive failures: ${describeError(error)}`)
      }
      return base
    }
  }

  // fetchImpl and apiKey arrive resolved from refine's guards: a private
  // field is not narrowed across a method boundary, and passing what the
  // guard already proved keeps the null check in one place.
  private async fetchReply(
    fetchImpl: LlmFetch,
    chunkText: string,
    apiKey: string | undefined,
  ): Promise<unknown> {
    const response = await fetchImpl(
      `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
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
      },
    )
    if (response.ok === false || (response.ok === undefined && (response.status ?? 0) >= 400)) {
      throw new Error(`llm status ${String(response.status ?? 'unknown')}`)
    }
    return await response.json()
  }
}

/** RefinePrompt builds the single user message asking for the JSON shape. */
function refinePrompt(chunkText: string): string {
  return 'Extract wake keywords and frameworks for this memory note chunk. '
    + 'Reply with ONLY a JSON object of the shape '
    + '{"wake_keywords": ["...", "..."], "trigger_frameworks": ["...", "..."]}. '
    + 'Lowercase terms only.\n\n---\n'
    + chunkText.slice(0, LLM_INPUT_CHAR_CAP)
}

// Pulls the JSON out of the chat reply: the message content, with a
// ```json fence stripped when a model wraps it. A missing content string is
// a failure, not an empty refinement.
function parseReply(payload: unknown): ReplyKeywords {
  const content = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>
  }).choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('llm response has no message content')
  }
  const jsonText = content
    .replace(/^```(?:json)?[ \t]*\n?/i, '')
    .replace(/```[ \t]*$/, '')
    .trim()
  return JSON.parse(jsonText) as ReplyKeywords
}

// Heuristic-first merge, deduped; endpoint values are trimmed and lowercased
// so casing differences never add a second copy of one term.
function mergeLists(base: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([
    ...base,
    ...extra.map((value) => value.trim().toLowerCase()).filter((value) => value !== ''),
  ])]
}

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}
