/**
 * HostContract mirrors the exact live-agent shapes the lifecycle hooks
 * consume: `agent/created` / `agent/disposed` payloads, the `Agent` handle's
 * session header (cwd, subagent origin), `agent.inject()`, and the
 * UserMessage the injection channel accepts. Verified against the live
 * event catalog (cordis 4.1.0 + the harness agent/tool packages' `Events`
 * augmentations): `agent/created` is serial and a throwing listener fails
 * agent creation, `agent/disposed` is emit, `agent/pre-step` is a waterfall
 * whose decision a non-owning listener must pass through unchanged, and
 * `tools/result` observes the frozen final outcome of one tool call.
 *
 * This package never imports the harness agent/tool packages at runtime
 * (PLAN TASK-031 canon, mirrors tools/host.ts): the shapes are declared
 * here and read structurally. The `Events` augmentation below only types
 * `ctx.on()` registrations; the names and payloads are the host's.
 * @module dsh-plugin-obsidian-mem/events/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GlobalMemorySource, SessionRegistryView, VaultEntry } from '../../service/lib/index.js'
import type {
  ExactSectionRequest,
  MemorySearchResult,
  SearchRequest,
} from '../../service/lib/search.js'

// ---------------------------------------------------------------------------
// Live agent mirror (verified against @deepseek-ai/dsh-agent runtime-types:
// Agent.id is the SessionId, Agent.session.header carries cwd and the
// origin === 'subagent' marker, Agent.inject queues next-step context).

export interface AgentSessionHeader {
  /** Absolute workspace dir the session was created in, when present. */
  readonly cwd?: string
  /** Present ('subagent') only for sessions created as subagent children. */
  readonly origin?: string
  /** Subagent nesting depth; absent (zero) for top-level sessions. */
  readonly delegationDepth?: number
  /** Id of the parent session for a delegated child; absent for roots. */
  readonly parentSession?: string
}

/** The agent-side context slice the hooks register through. */
export interface AgentHostContext {
  /** Registers a listener owned by the agent's own fiber. */
  on(name: 'agent/pre-step', listener: PreStepListener): () => boolean
  /** Registers the emit-style assistant-stream observer on the agent's fiber. */
  on(name: 'agent/assistant-stream', listener: (payload: AssistantStreamPayload) => void): () => boolean
  /** Registers a cleanup-aware effect on the agent's fiber; answers a disposer. */
  effect(execute: () => (() => void) | void, label?: string): EffectDisposer
}

/** Disposable returned by cordis `ctx.effect()`; calling it tears the effect down. */
export type EffectDisposer = () => unknown

/** The live-agent handle the lifecycle events carry. */
export interface LiveAgent {
  /** Session-backed identity: the same for every turn of this agent. */
  readonly id: string
  readonly session: { readonly header: AgentSessionHeader }
  /** The agent's own context; agent-scoped events fire here. */
  readonly ctx: AgentHostContext
  /** Queues model-facing context for the next step boundary without waking. */
  inject(message: InjectedUserMessage): void
}

// ---------------------------------------------------------------------------
// Message shapes (UserMessage per @deepseek-ai/dsh-llm: id + role + content
// blocks + producer-declared source; the source union is merge-extensible,
// so a plugin kind is admitted and unknown kinds fall through consumers).

export interface HostContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface InjectedMessageSource {
  readonly kind: 'plugin:obsidian-mem'
  readonly form: 'notice'
  /** One-line account, bounded like the harness producer (boundSummary). */
  readonly summary: string
}

export interface InjectedUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly HostContentBlock[]
  readonly source: InjectedMessageSource
}

/** A message the loop admitted into a step (pre-step payload element). */
export interface StepMessage {
  readonly content?: readonly HostContentBlock[]
  readonly source?: { readonly kind?: string }
}

// ---------------------------------------------------------------------------
// Event payloads.

export interface AgentCreatedPayload {
  readonly agent: LiveAgent
  readonly source: string
}

export interface AgentDisposedPayload {
  readonly agent: LiveAgent
}

/** PreStepDecision per @deepseek-ai/dsh-agent: enter with messages, or reject. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: readonly StepMessage[]; startsRequestSeries?: true }

export interface PreStepPayload {
  readonly agent: LiveAgent
  readonly messages: readonly StepMessage[]
  readonly turn: number
  readonly step: number
}

export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

// ---------------------------------------------------------------------------
// Assistant-stream mirror. Verified against the live cordis 4.1.0 Event
// catalog: `agent/assistant-stream` is emit with
// `(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame })`
// — the frame union is the ordered start/chunk/end publications of one
// attempt, and a chunk frame's `chunk` is the StreamChunk union
// (block-start | text-delta | reasoning-delta | tool-call-delta | block-end
// | usage | finish). Reasoning arrives on the native `reasoning-delta` /
// reasoning `block-end` channel, so a reasoning close is a completed think
// block in its own right (TASK-043). Only the text-bearing members are read,
// and every field access is type-guarded: emit dispatch runs the listener
// raw, so a poisoned payload may never throw out of it.

/** A streamed content block at close; `type` discriminates the block union. */
export interface ContentBlockMirror {
  readonly type: string
  /** Text- and reasoning blocks carry the full block text at close. */
  readonly text?: string
}

export type StreamChunkMirror =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType?: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text?: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text?: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly argumentsDelta?: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block?: ContentBlockMirror }
  | { readonly type: 'usage' }
  | { readonly type: 'finish' }

export interface AssistantStreamFrameMirror {
  readonly type: 'start' | 'chunk' | 'end'
  readonly attemptId: string
  readonly revision?: number
  /** start frame only: the turn the attempt streams in (per-turn budget hint). */
  readonly turn?: number
  readonly chunk?: StreamChunkMirror
  /** end frame only: committed vs abandoned attempt. */
  readonly outcome?: { readonly kind?: string }
}

export interface AssistantStreamPayload {
  readonly agent: LiveAgent
  readonly frame: AssistantStreamFrameMirror
}

/** The `tools/result` execution slice (name, parsed arguments, caller agent). */
export interface ToolExecutionMirror {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: LiveAgent
}

/**
 * The `tools/result` outcome slice (isError discriminates the union).
 * `value` is the canonical JsonValue a successful execution carries
 * (ToolExecutionSuccess in the installed @deepseek-ai/dsh-tools
 * 0.2.1-alpha.3 lib/types/index.d.ts): the in-process emit delivers it
 * to live listeners; the "omitted from durable events" note covers the
 * session-log projections only, so observers read it type-guarded and
 * treat absence (failures, older emitters) as "no structured outcome".
 */
export interface ToolResultMirror {
  readonly isError: boolean
  readonly content: readonly HostContentBlock[]
  readonly value?: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Serial; a throwing listener fails agent creation, so ours never throw. */
    'agent/created'(this: unknown, payload: AgentCreatedPayload): undefined | Promise<undefined>
    /** Emit; the agent left the registry. */
    'agent/disposed'(this: unknown, payload: AgentDisposedPayload): void
    /** Waterfall; observe the proposed step and pass the decision through. */
    'agent/pre-step'(
      this: unknown,
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
    /** Emit; observe the frozen final outcome of one tool call. */
    'tools/result'(
      this: unknown,
      exec: ToolExecutionMirror,
      result: ToolResultMirror,
    ): undefined
    /** Emit; Scoped<Agent>: fires on the agent ctx, not the plugin ctx. */
    'agent/assistant-stream'(this: unknown, payload: AssistantStreamPayload): void
  }
}

// ---------------------------------------------------------------------------
// Seam slices.

/**
 * ToolResultEvents is the plugin-ctx slice every `tools/result` observer
 * declares (Read intercept, memory-tool watch, write ledger): mount passes
 * the real ctx, tests inject a fake of the same shape.
 */
export interface ToolResultEvents {
  on(
    name: 'tools/result',
    listener: (exec: ToolExecutionMirror, result: ToolResultMirror) => undefined,
  ): () => boolean
}

/**
 * MemoryEventsService is the ctx.obsidianMem slice the lifecycle hooks
 * consume. The real ObsidianMemService satisfies it structurally; tests
 * inject a fake of the same shape.
 */
export interface MemoryEventsService {
  /** Idempotent lazy provisioning; the trigger call returns the notice. */
  ensureMemoryAccess(): Promise<string | undefined>
  listVaults(): VaultEntry[]
  /** Shared vaults' global memory files for TASK-014's pinned session-start injection. */
  globalMemorySources(): GlobalMemorySource[]
  search(request: SearchRequest): Promise<MemorySearchResult[]>
  /** Exact-section recall for the Read intercept (TASK-042). */
  searchExactSections(request: ExactSectionRequest): Promise<MemorySearchResult[]>
  /** Wires the events-owned SessionRegistry (TASK-040 seam). */
  setSessionRegistry(view: SessionRegistryView | null): void
  /**
   * The dream orchestrator's live single-flight guard (PLAN-dream-isolation
   * TASK-006): true only while a dream run is in flight; false before the
   * engine exists. The launch-window half of the recall gate pairs it with
   * SessionRegistry.isDreamLaunch.
   */
  dreamRunBusy(): boolean
  readonly config: {
    milvus: { dbPath: string }
    budgets: {
      turnStartRecallTokens: number
      globalMemoryTokens: number
      readSections: number
      readSectionTokens: number
      searchTopK: number
      thinkShotsPerTurn: number
    }
  }
}

/** The scoped-inject scope: the Context plus the memory seam. */
export type MemoryEventsScope = Context & {
  obsidianMem: MemoryEventsService
}

/** Logger surface the hooks report through. */
export interface HookLogger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/**
 * MakeNoticeMessage builds one injectable UserMessage: notice-form source,
 * one text block per entry. Ids are caller-supplied randomness; the harness
 * treats MessageId as an opaque identity string.
 */
export function makeNoticeMessage(
  id: string,
  summary: string,
  blocks: readonly string[],
): InjectedUserMessage {
  return {
    id,
    role: 'user',
    content: blocks.map((text) => ({ type: 'text', text } satisfies HostContentBlock)),
    source: { kind: 'plugin:obsidian-mem', form: 'notice', summary: boundSummary(summary) },
  }
}

/** NOTICE_SUMMARY_MAX_CHARS is the harness bound on one notice summary. */
export const NOTICE_SUMMARY_MAX_CHARS = 120

/** BoundSummary clamps a notice summary to {@link NOTICE_SUMMARY_MAX_CHARS}. */
export function boundSummary(summary: string): string {
  return summary.length <= NOTICE_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
}

/** FirstTextBlock returns the first non-empty text block of a message, or ''. */
export function firstTextBlock(message: StepMessage): string {
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text.trim() !== '') {
      return block.text.trim()
    }
  }
  return ''
}

/** FirstUserText returns the text of the first user-sourced message, or ''. */
export function firstUserText(messages: readonly StepMessage[]): string {
  for (const message of messages) {
    if (message.source?.kind === 'user') {
      const text = firstTextBlock(message)
      if (text !== '') {
        return text
      }
    }
  }
  return ''
}
