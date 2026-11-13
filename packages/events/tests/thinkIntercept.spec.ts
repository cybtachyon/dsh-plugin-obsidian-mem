/**
 * Think-stream intercept specs (TASK-043): completed-block detection over
 * stream fixtures (single-delta, tags split across frames, multiple blocks,
 * native reasoning-channel variants, unclosed blocks), the union keyword
 * vocabulary (INTENT_MARKERS + registry-held injected-source terms + the
 * shared vault's recorded .INTENTS.md entries), the per-turn
 * budgets.thinkShotsPerTurn counter with the new-turn reset, once-per-session
 * source dedupe, poisoned-payload containment, and disposal cleanup.
 * @module dsh-plugin-obsidian-mem/events/tests/thinkIntercept
 */

import { describe, expect, it } from 'vitest'

import type { VaultEntry } from '../../service/lib/index.js'
import type { AssistantStreamFrameMirror, HookLogger } from '../src/host.ts'
import { mountLifecycle } from '../src/index.ts'
import { installThinkIntercept, extractCompletedThinkBlocks, THINK_QUERY_MAX_CHARS } from '../src/thinkIntercept.ts'
import { SessionRegistry, wakeTermsForSource } from '../src/sessions.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  memoryResult,
  reasoningDelta,
  reasoningEnd,
  streamEnd,
  streamPayload,
  streamStart,
  tempDbPath,
  textDelta,
  userMessage,
  type FakeAgent,
  type FakeMemoryService,
} from './testkit.ts'

const QUIET_LOGGER: HookLogger = { info: () => {}, warn: () => {}, debug: () => {} }

const SHARED_VAULT: VaultEntry = { path: '/vault/shared', mode: 'shared', source: 'card' }

let idSeq = 0
function messageIds(): () => string {
  idSeq = 0
  return () => `msg-${(idSeq += 1)}`
}

const topic = memoryResult({
  source_path: 'markdown/milvus-ops.md',
  section_header: 'Milvus Ops',
  chunk_text: 'compaction cadence and why it stalls',
})

interface Harness {
  agent: FakeAgent
  memory: FakeMemoryService
  registry: ReturnType<typeof mountLifecycle>
  warnings: string[]
  dispose: () => void
  /** Flush the fire-and-forget recall promises (no timers are involved). */
  settle: () => Promise<void>
}

function harness(options: {
  budgets?: Partial<FakeMemoryService['config']['budgets']>
  searchResults?: ReturnType<typeof memoryResult>[]
  notice?: string
} = {}): Harness {
  const tmp = tempDbPath()
  const memory = fakeMemory({
    dbPath: tmp.dir,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.searchResults === undefined ? {} : { searchResults: options.searchResults }),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
  })
  const ctx = fakeEventsCtx(memory)
  const registry = mountLifecycle(ctx.scope, { newMessageId: messageIds() })
  const agent = fakeAgent({ id: 'session-1', cwd: '/work/tree' })
  ctx.emit('agent/created', agent.asCreated())
  return {
    agent,
    memory,
    registry,
    warnings: ctx.warnings,
    dispose: () => {
      for (const effect of [...agent.agentEffects]) {
        effect.dispose()
      }
    },
    settle: () => new Promise((resolve) => { setTimeout(resolve, 0) }),
  }
}

function stream(agent: FakeAgent, ...frames: AssistantStreamFrameMirror[]): void {
  for (const frame of frames) {
    agent.emitAssistantStream(streamPayload(agent, frame))
  }
}

/** Replace the seam's search so every call answers a distinct fresh source. */
function freshSources(h: Harness): void {
  let shots = 0
  h.memory.search = async (request) => {
    h.memory.searchRequests.push(request)
    shots += 1
    return [memoryResult({ source_path: `markdown/src-${String(shots)}.md`, chunk_text: `fact ${String(shots)}` })]
  }
}

describe('extractCompletedThinkBlocks (scan cursor)', () => {
  it('finds one completed block and consumes it exactly once', () => {
    const first = extractCompletedThinkBlocks('lead <think>why the build fails</think> tail', 0)
    expect(first.blocks).toEqual(['why the build fails'])
    const again = extractCompletedThinkBlocks('lead <think>why the build fails</think> tail', first.next)
    expect(again.blocks).toEqual([])
  })

  it('keeps an unclosed opener for the next scan (tag split across deltas)', () => {
    const partial = extractCompletedThinkBlocks('lead <think>why the', 0)
    expect(partial.blocks).toEqual([])
    const split = extractCompletedThinkBlocks('lead <think>why the build fai', partial.next)
    expect(split.blocks).toEqual([])
    const closed = extractCompletedThinkBlocks('lead <think>why the build fails</think>', split.next)
    expect(closed.blocks).toEqual(['why the build fails'])
  })

  it('keeps a partial opening tag across the cursor', () => {
    const open = extractCompletedThinkBlocks('text <thi', 0)
    const closed = extractCompletedThinkBlocks('text <think>term one</think>', open.next)
    expect(closed.blocks).toEqual(['term one'])
  })

  it('finds multiple blocks in one accumulated text', () => {
    const scan = extractCompletedThinkBlocks('<think>a debug note</think> mid <think>b how note</think>', 0)
    expect(scan.blocks).toEqual(['a debug note', 'b how note'])
  })
})

describe('think-stream recall', () => {
  it('injects wrapped recall for a completed block naming an intent marker', async () => {
    const h = harness({ searchResults: [topic] })
    stream(h.agent, streamStart('a1', 1), textDelta('working now <think>why does the build fail</think>', 'a1'))
    expect(h.agent.injected).toEqual([]) // fire-and-forget: the stream never blocks
    await h.settle()
    expect(h.memory.searchRequests).toHaveLength(1)
    expect(h.memory.searchRequests[0]).toMatchObject({
      query: 'why does the build fail',
      wakeKeywords: ['why'],
      topK: 2,
    })
    expect(h.agent.injected).toHaveLength(1)
    const blocks = h.agent.injected[0]?.content.map((block) => block.text) ?? []
    expect(blocks[0]).toContain('terms: why')
    expect(blocks[1]).toContain('<recalled_memory source="markdown/milvus-ops.md">')
    expect(h.registry.recallTokensUsed('session-1')).toBeGreaterThan(0)
    expect(h.memory.ensureCalls).toBe(1)
  })

  it('matches a block whose tags split across deltas exactly once', async () => {
    const h = harness({ searchResults: [topic] })
    stream(
      h.agent,
      streamStart('a1', 1),
      textDelta('prose <thi', 'a1'),
      textDelta('nk>how to fix the f', 'a1'),
      textDelta('laky spec</think> more prose', 'a1'),
      textDelta(' and a stray <think>unclosed', 'a1'),
    )
    await h.settle()
    expect(h.memory.searchRequests).toHaveLength(1)
    expect(h.agent.injected).toHaveLength(1)
  })

  it('drops blocks with no vocabulary hit and never touches the seam', async () => {
    const h = harness({ searchResults: [topic] })
    stream(h.agent, streamStart('a1', 1), textDelta('<think>nothing relevant here at all zzz</think>', 'a1'))
    await h.settle()
    expect(h.memory.ensureCalls).toBe(0)
    expect(h.memory.searchRequests).toHaveLength(0)
    expect(h.agent.injected).toHaveLength(0)
  })

  it('never injects an unclosed block, even at a committed attempt end', async () => {
    const h = harness({ searchResults: [topic] })
    stream(
      h.agent,
      streamStart('a1', 1),
      textDelta('<think>why still open', 'a1'),
      streamEnd('a1', 'committed'),
    )
    await h.settle()
    expect(h.agent.injected).toHaveLength(0)
  })

  it('treats the native reasoning channel close as a completed block', async () => {
    const h = harness({ searchResults: [topic] })
    stream(
      h.agent,
      streamStart('a1', 1),
      reasoningDelta('investigate: the flaky ', 'a1', 0),
      reasoningDelta('milvus compaction', 'a1', 0),
      reasoningEnd(undefined, 'a1', 0),
    )
    await h.settle()
    expect(h.memory.searchRequests).toHaveLength(1)
    expect(h.memory.searchRequests[0]?.wakeKeywords).toContain('investigate')
    expect(h.agent.injected).toHaveLength(1)
  })

  it('uses the reasoning block text at close when the provider carries it', async () => {
    const h = harness({ searchResults: [topic] })
    stream(h.agent, streamStart('a1', 1), reasoningEnd('troubleshoot the probe timeout', 'a1', 0))
    await h.settle()
    expect(h.agent.injected).toHaveLength(1)
  })

  it('caps the query at 500 chars of block text', async () => {
    const h = harness({ searchResults: [topic] })
    const long = `debug ${'x '.repeat(600)}`
    stream(h.agent, streamStart('a1', 1), textDelta(`<think>${long}</think>`, 'a1'))
    await h.settle()
    expect((h.memory.searchRequests[0]?.query ?? '').length).toBe(THINK_QUERY_MAX_CHARS)
  })

  it('prepends the one-time provisioning notice to the injection', async () => {
    const h = harness({ searchResults: [topic], notice: 'Default vault created at /v/default' })
    stream(h.agent, streamStart('a1', 1), textDelta('<think>debug this</think>', 'a1'))
    await h.settle()
    expect(h.agent.injected.map((message) => message.content[0]?.text)).toEqual([
      'Default vault created at /v/default',
      expect.stringContaining('terms: debug'),
    ])
  })
})

describe('think vocabulary union', () => {
  it('matches wake terms the registry kept for sources injected earlier', async () => {
    const h = harness({ searchResults: [topic] })
    h.registry.noteWakeTerms('session-1', wakeTermsForSource(topic))
    stream(h.agent, streamStart('a1', 1), textDelta('<think>cadence questions about ops</think>', 'a1'))
    await h.settle()
    // "ops" is a registry-held header term of the injected source;
    // "cadence" is not in the vocabulary and does not match.
    expect(h.memory.searchRequests[0]?.wakeKeywords).toEqual(['ops'])
  })

  it('matches recorded .INTENTS.md entry terms from the first shared vault', async () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({
      dbPath: tmp.dir,
      searchResults: [topic],
      vaults: [SHARED_VAULT],
    })
    const registry = new SessionRegistry({
      file: `${tmp.dir}/state/sessions.json`,
      thinkShotsPerTurn: 3,
      debounceMs: 0,
    })
    const agent = fakeAgent({ id: 'session-intents' })
    installThinkIntercept({
      agent: agent as never,
      memory,
      registry,
      logger: QUIET_LOGGER,
      intentsFs: {
        readFile: (path) => path === '/vault/shared/.INTENTS.md'
          ? [
              '# Memory intents',
              '',
              '## debug',
              '',
              '- Milvus compaction cadence stalls',
              '',
              '## who',
              '',
              'People, tools, and services a memory involves.',
              '',
            ].join('\n')
          : null,
      },
      newMessageId: messageIds(),
    })
    // "stalled" is recorded content; "People, tools" is the seed hint line
    // (never a term source).
    stream(agent, streamStart('a1', 1), textDelta('<think>cadence stalled milvus</think>', 'a1'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(memory.searchRequests).toHaveLength(1)
    expect(memory.searchRequests[0]?.wakeKeywords.sort()).toEqual(['cadence', 'milvus'])
  })
})

describe('think budget and dedupe', () => {
  it('dedupes the once-injected source across blocks in one stream', async () => {
    const h = harness({ budgets: { thinkShotsPerTurn: 2 }, searchResults: [topic] })
    stream(
      h.agent,
      streamStart('a1', 1),
      textDelta('<think>why one</think>', 'a1'),
      textDelta('<think>why two</think>', 'a1'),
      textDelta('<think>why three</think>', 'a1'),
    )
    await h.settle()
    expect(h.agent.injected).toHaveLength(1)
    expect(h.registry.thinkBudgetLeft('session-1')).toBe(2 - 1)
  })

  it('caps injections at budgets.thinkShotsPerTurn per turn', async () => {
    const h = harness({ budgets: { thinkShotsPerTurn: 2 } })
    freshSources(h)
    stream(
      h.agent,
      streamStart('a1', 1),
      textDelta('<think>why one</think>', 'a1'),
      textDelta('<think>debug two</think>', 'a1'),
      textDelta('<think>how three</think>', 'a1'),
      textDelta('<think>troubleshoot four</think>', 'a1'),
    )
    await h.settle()
    // All four candidates search (the cap is spent per injection); only
    // two injections get a shot.
    expect(h.memory.searchRequests).toHaveLength(4)
    expect(h.agent.injected).toHaveLength(2)
    expect(h.registry.thinkBudgetLeft('session-1')).toBe(0)
    // A later block in the same turn is gated before the seam is touched.
    stream(h.agent, textDelta('<think>when five</think>', 'a1'))
    await h.settle()
    expect(h.memory.searchRequests).toHaveLength(4)
    expect(h.agent.injected).toHaveLength(2)
  })

  it('resets the shot counter on a new turn', async () => {
    const h = harness({ budgets: { thinkShotsPerTurn: 1 } })
    freshSources(h)
    stream(h.agent, streamStart('a1', 1), textDelta('<think>why one</think>', 'a1'))
    await h.settle()
    expect(h.agent.injected).toHaveLength(1)
    stream(h.agent, textDelta('<think>why two</think>', 'a1'))
    await h.settle()
    expect(h.agent.injected).toHaveLength(1) // same turn: the cap is spent
    h.registry.noteTurn('session-1', 2)
    stream(h.agent, textDelta('<think>why three</think>', 'a1'))
    await h.settle()
    expect(h.agent.injected).toHaveLength(2) // new turn: a fresh shot
  })

  it('resets the shot counter from the start-frame turn hint', async () => {
    const h = harness({ budgets: { thinkShotsPerTurn: 1 } })
    freshSources(h)
    stream(h.agent, streamStart('a1', 1), textDelta('<think>why one</think>', 'a1'))
    await h.settle()
    stream(h.agent, streamStart('a2', 2), textDelta('<think>why two</think>', 'a2'))
    await h.settle()
    expect(h.agent.injected).toHaveLength(2)
  })

  it('counts a subagent session under its own key (budgets are per process)', async () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir, searchResults: [topic] })
    const ctx = fakeEventsCtx(memory)
    const registry = mountLifecycle(ctx.scope, { newMessageId: messageIds() })
    const child = fakeAgent({ id: 'session-child', origin: 'subagent' })
    ctx.emit('agent/created', child.asCreated())
    stream(child, streamStart('a1', 1), textDelta('<think>why does this fail</think>', 'a1'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The Think intercept is gated by the budget, not by subagent-ness.
    expect(child.injected).toHaveLength(1)
    expect(registry.recallTokensUsed('session-child')).toBeGreaterThan(0)
    expect(registry.recallTokensUsed('session-absent')).toBe(0)
  })
})

describe('poisoned payloads and disposal', () => {
  it('survives malformed frames without throwing or injecting', async () => {
    const h = harness({ searchResults: [topic] })
    const poison: unknown[] = [
      { agent: h.agent, frame: null },
      { agent: h.agent, frame: {} },
      { agent: h.agent, frame: { type: 'chunk', attemptId: 'a1', chunk: null } },
      { agent: h.agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 42 } } },
      { agent: h.agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'block-end', block: 'nope' } } },
      { agent: h.agent, frame: { type: 'start' } },
      { agent: h.agent, frame: { type: 'nonsense' } },
      null,
    ]
    for (const payload of poison) {
      expect(() => {
        h.agent.emitAssistantStream(payload as never)
      }).not.toThrow()
    }
    await h.settle()
    expect(h.agent.injected).toHaveLength(0)
  })

  it('survives a poisoned agent id', () => {
    const h = harness({ searchResults: [topic] })
    const broken = { id: { toString: () => { throw new Error('no id') } }, ctx: h.agent.ctx }
    expect(() => {
      h.agent.emitAssistantStream({ agent: broken as never, frame: streamStart('a1', 1) } as never)
    }).not.toThrow()
    expect(h.warnings.some((line) => line.includes('think-intercept failed'))).toBe(true)
  })

  it('drops the listener and buffers on dispose', async () => {
    const h = harness({ searchResults: [topic] })
    stream(h.agent, streamStart('a1', 1), textDelta('<think>why half a', 'a1'))
    h.dispose()
    // The close re-delivered after disposal finds no listener at all.
    stream(h.agent, textDelta('block</think>', 'a1'))
    await h.settle()
    expect(h.agent.injected).toHaveLength(0)
  })

  it('abandoned attempts never inject', async () => {
    const h = harness({ searchResults: [topic] })
    stream(
      h.agent,
      streamStart('a1', 1),
      textDelta('lead <think>why stalled compaction', 'a1'),
      streamEnd('a1', 'abandoned'),
    )
    await h.settle()
    expect(h.agent.injected).toHaveLength(0)
  })
})

describe('mount wiring', () => {
  it('registers the assistant-stream listener on the agent ctx from agent/created', () => {
    const h = harness()
    expect(h.agent.agentHandlers.has('agent/assistant-stream')).toBe(true)
    expect(h.agent.agentEffects.map((effect) => effect.label)).toEqual(['obsidian-mem-events.agent'])
  })

  it('turn-start recall sources feed the session wake vocabulary', async () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir, searchResults: [topic] })
    const ctx = fakeEventsCtx(memory)
    const registry = mountLifecycle(ctx.scope, { newMessageId: messageIds() })
    const agent = fakeAgent({ id: 'session-fed' })
    ctx.emit('agent/created', agent.asCreated())
    await agent.emitPreStep(
      { agent: agent as never, messages: [userMessage('milvus compaction cadence')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(registry.wakeTermsFor('session-fed').has('milvus')).toBe(true)
    // A later think block naming the held term uses it.
    stream(agent, streamStart('a1', 2), textDelta('<think>milvus again</think>', 'a1'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(memory.searchRequests.at(-1)?.wakeKeywords).toContain('milvus')
  })
})
