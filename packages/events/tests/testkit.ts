/**
 * Shared test kit for the events specs: a fake ctx (plugin-level event
 * registry + effects), a fake memory seam implementing the MemoryEventsService
 * slice with call ledgers, and a fake live agent (agent.ctx listener/effects
 * registry + inject ledger) faithful to the harness dispatch shapes
 * (serial agent/created, waterfall agent/pre-step, emit tools/result).
 * @module dsh-plugin-obsidian-mem/events/tests/testkit
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GlobalMemorySource, SessionRegistryView, VaultEntry } from '../../service/lib/index.js'
import type {
  ExactSectionRequest,
  MemorySearchResult,
  SearchRequest,
} from '../../service/lib/search.js'
import type {
  AgentCreatedPayload,
  AgentDisposedPayload,
  AgentHostContext,
  AssistantStreamPayload,
  InjectedUserMessage,
  MemoryEventsScope,
  MemoryEventsService,
  PreStepDecision,
  PreStepPayload,
  StepMessage,
  StreamChunkMirror,
  ToolExecutionMirror,
  ToolResultMirror,
} from '../src/host.ts'

// ---------------------------------------------------------------------------
// Memory seam fake.

export interface FakeMemoryOptions {
  dbPath: string
  /** The one-time provisioning notice; only the FIRST ensure call sees it. */
  notice?: string
  searchResults?: MemorySearchResult[]
  searchError?: Error
  exactResults?: MemorySearchResult[]
  exactError?: Error
  vaults?: VaultEntry[]
  /** The shared vaults' global memory files the seam answers (TASK-014). */
  globalMemorySources?: GlobalMemorySource[]
  budgets?: Partial<MemoryEventsService['config']['budgets']>
  /** The dreamRunBusy seam answer (TASK-006 launch-window gate); default false. */
  dreamRunBusy?: boolean
}

export interface FakeMemoryService extends MemoryEventsService {
  ensureCalls: number
  searchRequests: SearchRequest[]
  exactRequests: ExactSectionRequest[]
  registryWires: Array<SessionRegistryView | null>
  globalMemorySourcesCalls: number
  /** Toggle the live dreamRunBusy answer (TASK-006 gate tests). */
  setDreamRunBusy(value: boolean): void
}

export function fakeMemory(options: FakeMemoryOptions): FakeMemoryService {
  const budgets = {
    turnStartRecallTokens: 1200,
    globalMemoryTokens: 1500,
    readSections: 2,
    readSectionTokens: 350,
    searchTopK: 6,
    thinkShotsPerTurn: 3,
    ...options.budgets,
  }
  let dreamRunBusy = options.dreamRunBusy ?? false
  const fake: FakeMemoryService = {
    ensureCalls: 0,
    searchRequests: [],
    exactRequests: [],
    registryWires: [],
    globalMemorySourcesCalls: 0,
    config: { milvus: { dbPath: options.dbPath }, budgets },
    dreamRunBusy() {
      return dreamRunBusy
    },
    setDreamRunBusy(value) {
      dreamRunBusy = value
    },
    async ensureMemoryAccess() {
      fake.ensureCalls += 1
      return fake.ensureCalls === 1 ? options.notice : undefined
    },
    listVaults() {
      return (options.vaults ?? []).map((entry) => ({ ...entry }))
    },
    globalMemorySources() {
      fake.globalMemorySourcesCalls += 1
      return (options.globalMemorySources ?? []).map((source) => ({ ...source }))
    },
    async search(request) {
      fake.searchRequests.push(request)
      if (options.searchError !== undefined) {
        throw options.searchError
      }
      return options.searchResults ?? []
    },
    async searchExactSections(request) {
      fake.exactRequests.push(request)
      if (options.exactError !== undefined) {
        throw options.exactError
      }
      return options.exactResults ?? []
    },
    setSessionRegistry(view) {
      fake.registryWires.push(view)
    },
  }
  return fake
}

/** One MemorySearchResult with sensible fillers. */
export function memoryResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    chunk_id: 1,
    source_path: 'topic.md',
    section_header: 'Topic',
    chunk_text: 'the fact, stated plainly',
    scope: 'global',
    vault: '/home/test/vault',
    mode: 'shared',
    updated_at: 1_700_000_000_000,
    score: 0.9,
    ...overrides,
  }
}

/** One user-sourced step message. */
export function userMessage(text: string): StepMessage {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

// ---------------------------------------------------------------------------
// Plugin-ctx fake.

export interface FakeEventsCtx {
  scope: MemoryEventsScope
  handlers: Map<string, Array<(payload: never, next?: never) => unknown>>
  warnings: string[]
  infos: string[]
  effectDisposers: Array<() => unknown>
  /** Fire one plugin-ctx emit-style event at every registered listener. */
  emit(name: 'agent/created' | 'agent/disposed' | 'tools/result', ...args: unknown[]): void
}

export function fakeEventsCtx(obsidianMem: MemoryEventsService): FakeEventsCtx {
  const handlers = new Map<string, Array<(payload: never, next?: never) => unknown>>()
  const warnings: string[] = []
  const infos: string[] = []
  const effectDisposers: Array<() => unknown> = []
  const scope = {
    obsidianMem,
    logger: () => ({
      info: (message: unknown) => { infos.push(String(message)) },
      warn: (message: unknown) => { warnings.push(String(message)) },
      debug: () => {},
    }),
    effect: (execute: () => () => unknown) => {
      const dispose = execute()
      const wrapper = () => { dispose() }
      effectDisposers.push(wrapper)
      return wrapper
    },
    on: (name: string, listener: (payload: never, next?: never) => unknown) => {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
  }
  const ctx: FakeEventsCtx = {
    scope: scope as unknown as MemoryEventsScope,
    handlers,
    warnings,
    infos,
    effectDisposers,
    emit(name, ...args) {
      for (const listener of [...(handlers.get(name) ?? [])]) {
        ;(listener as (...a: unknown[]) => void)(...args)
      }
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Live-agent fake.

export interface FakeAgentOptions {
  id: string
  cwd?: string
  origin?: string
  delegationDepth?: number
  parentSession?: string
}

export interface FakeAgent {
  id: string
  session: { header: Record<string, unknown> }
  /** The agent-ctx listener/effect registry, typed as the host slice. */
  ctx: AgentHostContext
  inject(message: InjectedUserMessage): void
  injected: InjectedUserMessage[]
  agentHandlers: Map<string, Array<(payload: never, next?: never) => unknown>>
  agentEffects: Array<{ label: string, dispose: () => unknown }>
  emitPreStep(payload: PreStepPayload, inner: () => Promise<PreStepDecision>): Promise<PreStepDecision[]>
  /** Fire the emit-style assistant-stream at the agent-ctx listeners. */
  emitAssistantStream(payload: AssistantStreamPayload): void
  asCreated(): AgentCreatedPayload
  asDisposed(): AgentDisposedPayload
  asToolCaller(name: string, args: unknown): ToolExecutionMirror
}

export function fakeAgent(options: FakeAgentOptions): FakeAgent {
  const injected: InjectedUserMessage[] = []
  const agentHandlers = new Map<string, Array<(payload: never, next?: never) => unknown>>()
  const agentEffects: Array<{ label: string, dispose: () => unknown }> = []
  const agent = {
    id: options.id,
    session: {
      header: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      },
    },
    injected,
    agentHandlers,
    agentEffects,
    ctx: {
      on: (name: string, listener: (payload: never, next?: never) => unknown) => {
        const list = agentHandlers.get(name) ?? []
        list.push(listener)
        agentHandlers.set(name, list)
        return () => {
          const index = list.indexOf(listener)
          if (index >= 0) list.splice(index, 1)
          return index >= 0
        }
      },
      effect: (execute: () => (() => void) | void, label = 'anonymous') => {
        const dispose = execute()
        const entry = {
          label,
          dispose: () => { dispose?.() },
        }
        agentEffects.push(entry)
        return entry.dispose
      },
    },
    inject: (message: InjectedUserMessage) => { injected.push(message) },
    async emitPreStep(payload: PreStepPayload, inner: () => Promise<PreStepDecision>) {
      const decisions: PreStepDecision[] = []
      // Compose the registered listeners around the inner next(), the way
      // the cordis waterfall dispatch does (outermost listener first).
      const listeners = [...(agentHandlers.get('agent/pre-step') ?? [])].reverse()
      let next = inner
      for (const listener of listeners) {
        const innerNext = next
        const current = listener as unknown as (
          p: PreStepPayload,
          n: () => Promise<PreStepDecision>,
        ) => Promise<PreStepDecision>
        const wrapped = async (): Promise<PreStepDecision> => current(payload, innerNext)
        next = wrapped
      }
      decisions.push(await next())
      return decisions
    },
    emitAssistantStream(payload: AssistantStreamPayload) {
      // Emit dispatch: listeners run raw, in registration order.
      for (const listener of [...(agentHandlers.get('agent/assistant-stream') ?? [])]) {
        ;(listener as (p: AssistantStreamPayload) => void)(payload)
      }
    },
    asCreated: () => ({ agent: agent as never, source: 'startup' }),
    asDisposed: () => ({ agent: agent as never }),
    asToolCaller: (name: string, args: unknown) => ({ name, arguments: args, agent: agent as never }),
  }
  return agent as unknown as FakeAgent
}

// ---------------------------------------------------------------------------
// Assistant-stream fixtures. The payloads carry exactly the fields the
// host.ts frame mirror declares; the extra live-frame fields (start `step`,
// end/chunk `index`, chunk `time`) are never read, so they stay out.

/** One `start` frame for an attempt streaming in `turn`. */
export function streamStart(attemptId = 'attempt-1', turn = 1): AssistantStreamPayload['frame'] {
  return { type: 'start', attemptId, revision: 0, turn }
}

/** One `end` frame; kind is the attempt outcome. */
export function streamEnd(
  attemptId = 'attempt-1',
  kind: 'committed' | 'abandoned' = 'committed',
): AssistantStreamPayload['frame'] {
  return { type: 'end', attemptId, revision: 0, outcome: { kind } }
}

function chunkFrame(
  attemptId: string,
  chunk: StreamChunkMirror,
): AssistantStreamPayload['frame'] {
  return { type: 'chunk', attemptId, revision: 0, chunk }
}

/** A text-delta chunk frame carrying `text`. */
export function textDelta(text: string, attemptId = 'attempt-1'): AssistantStreamPayload['frame'] {
  return chunkFrame(attemptId, { type: 'text-delta', index: 0, text })
}

/** A native reasoning-delta chunk frame. */
export function reasoningDelta(text: string, attemptId = 'attempt-1', index = 0): AssistantStreamPayload['frame'] {
  return chunkFrame(attemptId, { type: 'reasoning-delta', index, text })
}

/** A reasoning block-end close frame; block text absent uses the deltas. */
export function reasoningEnd(text?: string, attemptId = 'attempt-1', index = 0): AssistantStreamPayload['frame'] {
  return chunkFrame(
    attemptId,
    { type: 'block-end', index, block: { type: 'reasoning', ...(text === undefined ? {} : { text }) } },
  )
}

/** Wrap a frame for the agent-ctx payload. */
export function streamPayload(agent: FakeAgent, frame: AssistantStreamPayload['frame']): AssistantStreamPayload {
  return { agent: agent as never, frame }
}

/**
 * The tool result envelope the intercept observes. `value` is the
 * structured ToolExecutionSuccess payload the live emit carries (absent
 * keys stay absent for exactOptionalPropertyTypes fidelity).
 */
export function toolResult(
  isError: boolean,
  text: string,
  value?: unknown,
): ToolResultMirror {
  return {
    isError,
    content: [{ type: 'text', text }],
    ...(value === undefined ? {} : { value }),
  }
}

/** A temp state dir; the registry file lands under <dir>/state/. */
export function tempDbPath(): { dir: string, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-mem-events-'))
  return {
    dir,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}
