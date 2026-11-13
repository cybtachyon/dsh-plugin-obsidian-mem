/**
 * Turn-end reminder specs (TASK-044): exactly one steer per turn with the
 * byte-exact verbatim checklist (snapshot) whose `<FIRST_SHARED_VAULT>` is
 * interpolated from the live vault registry (first shared, default path when
 * none are shared); the anti-loop guard across repeated turn-stopping fires
 * (a steer keeps the turn open); subagent skip; memory_*-tool-used skip via
 * the plugin-ctx tools/result watcher keyed by agent; trivial-turn skip with
 * the WORK_MARKER exception; steer-only delivery (no inject, no followup, no
 * provisioning).
 * @module dsh-plugin-obsidian-mem/events/tests/turnEnd
 */

import { describe, expect, it } from 'vitest'

import type { HookLogger } from '../src/host.ts'
import { mountLifecycle } from '../src/index.ts'
import { SessionRegistry } from '../src/sessions.ts'
import { installMemoryToolWatch, installTurnEnd, isTrivialTurn, turnEndReminder } from '../src/turnEnd.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  tempDbPath,
  toolResult,
  userMessage,
  type FakeAgent,
} from './testkit.ts'

const QUIET_LOGGER: HookLogger = { info: () => {}, warn: () => {}, debug: () => {} }

/** The task-file checklist transcribed line-for-line, path hole filled. */
function expectedReminder(vaultPath: string): string {
  return [
    '1. When you have learned something durable worth knowing in a future session: confirm it isn\'t already in the repo / git / AGENTS.md and isn\'t a secret value. Don\'t duplicate the source of truth.',
    '2. Use the `memory_search` tool and update an existing note rather than duplicate; otherwise write one atomic markdown file (one fact) with the `memory_write` tool.',
    '3. New memories go in the most related shared vault.',
    '4. The memory must carry a Why: line and a How to apply: line in the body.',
    '5. Archive memories that turn out wrong with the `memory_write` tool.',
    '6. Never store secret values, only where they live.',
    '7. Evaluate your turn and find instances where existing memories would have assisted you.',
    'Check if there were any significant patterns in your language that would indicate a use for the memory,',
    `then update ${vaultPath}/.INTENTS.md with those intent(s).`,
    '8. Run the `memory_audit` tool.',
  ].join('\n')
}

interface UnitHarness {
  agent: FakeAgent
  registry: SessionRegistry
  warnings: string[]
  stopTurn: (turn: number) => Promise<void>
  useMemoryTool: (name: string) => void
}

/** installTurnEnd + installMemoryToolWatch without the turn-start flow. */
function unit(options: {
  vaults?: Parameters<typeof fakeMemory>[0]['vaults']
  subagent?: boolean
} = {}): UnitHarness {
  const tmp = tempDbPath()
  const memory = fakeMemory({
    dbPath: tmp.dir,
    ...(options.vaults === undefined ? {} : { vaults: options.vaults }),
  })
  const ctx = fakeEventsCtx(memory)
  const registry = new SessionRegistry({
    file: `${tmp.dir}/state/sessions.json`,
    thinkShotsPerTurn: 3,
    debounceMs: 0,
  })
  const agent = fakeAgent({
    id: 'session-1',
    ...(options.subagent === true ? { origin: 'subagent' } : {}),
  })
  registry.ensure('session-1', { subagent: options.subagent === true })
  let ids = 0
  installTurnEnd({
    agent: agent as never,
    memory,
    registry,
    logger: QUIET_LOGGER,
    homedir: () => '/fake/home',
    newMessageId: () => `steer-${(ids += 1)}`,
  })
  installMemoryToolWatch({ ctx: ctx.scope as never, registry, logger: QUIET_LOGGER })
  return {
    agent,
    registry,
    warnings: ctx.warnings,
    stopTurn: (turn) => agent.emitTurnStopping({ agent: agent as never, turn }),
    useMemoryTool: (name) => {
      ctx.emit('tools/result', agent.asToolCaller(name, {}), toolResult(false, 'ok'))
    },
  }
}

const WORK_TEXT = 'Refactor the retry ladder in /api/gateway before Friday'

describe('turn-end reminder delivery', () => {
  it('steers once with the byte-exact checklist and the first shared vault path', async () => {
    const h = unit({
      vaults: [
        { path: '/v/readonly-one', mode: 'read-only', source: 'settings' },
        { path: '/v/shared-two', mode: 'shared', source: 'settings' },
      ],
    })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(1)
    const message = h.agent.steered[0]
    expect(message?.source).toEqual({
      kind: 'plugin:obsidian-mem',
      form: 'notice',
      summary: 'obsidian-mem: turn-end save/audit reminder',
    })
    expect(message?.role).toBe('user')
    const text = message?.content.map((block) => block.text).join('\n')
    expect(text).toBe(expectedReminder('/v/shared-two'))
    expect(text).toMatchInlineSnapshot(`
      "1. When you have learned something durable worth knowing in a future session: confirm it isn't already in the repo / git / AGENTS.md and isn't a secret value. Don't duplicate the source of truth.
      2. Use the \`memory_search\` tool and update an existing note rather than duplicate; otherwise write one atomic markdown file (one fact) with the \`memory_write\` tool.
      3. New memories go in the most related shared vault.
      4. The memory must carry a Why: line and a How to apply: line in the body.
      5. Archive memories that turn out wrong with the \`memory_write\` tool.
      6. Never store secret values, only where they live.
      7. Evaluate your turn and find instances where existing memories would have assisted you.
      Check if there were any significant patterns in your language that would indicate a use for the memory,
      then update /v/shared-two/.INTENTS.md with those intent(s).
      8. Run the \`memory_audit\` tool."
    `)
  })

  it('falls back to the default vault path when no shared vault is registered', async () => {
    const h = unit({ vaults: [{ path: '/v/readonly-one', mode: 'read-only', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(1)
    expect(h.agent.steered[0]?.content[0]?.text).toContain('/fake/home/.dsh/obsidian-mem/.INTENTS.md')
  })

  it('pure turnEndReminder answers the default path for an empty registry', () => {
    expect(turnEndReminder([], '/fake/home')).toBe(expectedReminder('/fake/home/.dsh/obsidian-mem'))
  })

  it('steers only: nothing injects and the reminder never provisions', async () => {
    const h = unit()
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(1)
    expect(h.agent.injected).toHaveLength(0)
    // The reminder itself is static text: no ensureMemoryAccess, no search.
    expect(h.warnings).toEqual([])
  })

  it('never calls ensureMemoryAccess for the reminder flow', async () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir })
    const registry = new SessionRegistry({ file: `${tmp.dir}/state/sessions.json`, thinkShotsPerTurn: 3, debounceMs: 0 })
    const agent = fakeAgent({ id: 'session-quiet' })
    installTurnEnd({ agent: agent as never, memory, registry, logger: QUIET_LOGGER, homedir: () => '/fake/home' })
    registry.noteTurn('session-quiet', 1, WORK_TEXT)
    await agent.emitTurnStopping({ agent: agent as never, turn: 1 })
    expect(agent.steered).toHaveLength(1)
    expect(memory.ensureCalls).toBe(0)
    expect(memory.searchRequests).toHaveLength(0)
  })
})

describe('once-per-turn guard (steer keeps the turn open)', () => {
  it('survives repeated turn-stopping fires in the same turn without looping', async () => {
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    // A steer keeps the turn open: the machine re-reads its inbox and the
    // listener re-fires. The guard must answer with exactly one steer.
    await h.stopTurn(1)
    await h.stopTurn(1)
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(1)
  })

  it('fires again on the next turn, still once per turn', async () => {
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    await h.stopTurn(1)
    await h.stopTurn(1)
    h.registry.noteTurn('session-1', 2, 'Now sweep the flaky specs under tests/api')
    await h.stopTurn(2)
    await h.stopTurn(2)
    expect(h.agent.steered).toHaveLength(2)
  })

  it('a poisoned payload never throws out of the serial listener', async () => {
    const h = unit()
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    // Missing agent falls back to the install agent; a non-numeric turn
    // behaves as one opaque marker. Neither may escape the listener.
    await expect(h.agent.emitTurnStopping({ turn: 1 } as never)).resolves.toBeUndefined()
    await expect(
      h.agent.emitTurnStopping({ turn: 'not-a-number', agent: undefined } as never),
    ).resolves.toBeUndefined()
  })
})

describe('skip conditions', () => {
  it('subagent sessions never get the reminder', async () => {
    const h = unit({ subagent: true, vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(0)
  })

  it('a turn that used a memory_* tool is skipped', async () => {
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    h.useMemoryTool('memory_search')
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(0)
  })

  it('every memory tool name qualifies, other tools do not', async () => {
    for (const name of ['memory_read', 'memory_search', 'memory_write', 'memory_dream', 'memory_audit']) {
      const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
      h.registry.noteTurn('session-1', 1, WORK_TEXT)
      h.useMemoryTool(name)
      await h.stopTurn(1)
      expect(h.agent.steered, name).toHaveLength(0)
    }
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    h.useMemoryTool('read')
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(1)
  })

  it('the memory-tool flag resets on a new turn', async () => {
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, WORK_TEXT)
    h.useMemoryTool('memory_audit')
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(0)
    h.registry.noteTurn('session-1', 2, 'Now sweep the flaky specs under tests/api')
    await h.stopTurn(2)
    expect(h.agent.steered).toHaveLength(1)
  })

  it('trivial turns are skipped; work markers exempt them', async () => {
    expect(isTrivialTurn('hi')).toBe(true)
    expect(isTrivialTurn('thanks!')).toBe(true)
    expect(isTrivialTurn('')).toBe(true)
    expect(isTrivialTurn('a'.repeat(24))).toBe(true) // at the cap, no marker
    expect(isTrivialTurn('a'.repeat(25))).toBe(false)
    expect(isTrivialTurn('look at /tmp please')).toBe(false) // path marker
    expect(isTrivialTurn('fix the `spec.ts` run')).toBe(false) // code tick
    expect(isTrivialTurn('C:\\dsh\\logs path')).toBe(false) // windows separator

    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    h.registry.noteTurn('session-1', 1, 'thanks!')
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(0)

    const exempt = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    exempt.registry.noteTurn('session-1', 1, 'look at /tmp please')
    await exempt.stopTurn(1)
    expect(exempt.agent.steered).toHaveLength(1)
  })

  it('a turn whose first user text never surfaced stays quiet', async () => {
    const h = unit({ vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }] })
    await h.stopTurn(1)
    expect(h.agent.steered).toHaveLength(0)
  })
})

describe('mount wiring', () => {
  it('registers turn-stopping on the agent ctx and the tool watch on the plugin ctx', () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir })
    const ctx = fakeEventsCtx(memory)
    mountLifecycle(ctx.scope)
    const agent = fakeAgent({ id: 'session-wired' })
    ctx.emit('agent/created', agent.asCreated())
    expect(agent.agentHandlers.has('agent/turn-stopping')).toBe(true)
    expect(ctx.handlers.get('tools/result') ?? []).toHaveLength(2) // read + memory watch
  })

  it('captures the first user text from the pre-step waterfall end to end', async () => {
    const tmp = tempDbPath()
    const memory = fakeMemory({
      dbPath: tmp.dir,
      vaults: [{ path: '/v/shared', mode: 'shared', source: 'settings' }],
    })
    const ctx = fakeEventsCtx(memory)
    mountLifecycle(ctx.scope)
    const agent = fakeAgent({ id: 'session-e2e' })
    ctx.emit('agent/created', agent.asCreated())
    await agent.emitPreStep(
      { agent: agent as never, messages: [userMessage('ship the billing export milestone')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    await agent.emitTurnStopping({ agent: agent as never, turn: 1 })
    await agent.emitTurnStopping({ agent: agent as never, turn: 1 })
    expect(agent.steered).toHaveLength(1)
    // Pre-stopping tool use of the NEXT turn must not leak back: turn 2 with
    // a memory tool stays quiet, turn 3 without one fires again.
    await agent.emitPreStep(
      { agent: agent as never, messages: [userMessage('second milestone for the export')], turn: 2, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    ctx.emit('tools/result', agent.asToolCaller('memory_write', {}), toolResult(false, 'ok'))
    await agent.emitTurnStopping({ agent: agent as never, turn: 2 })
    expect(agent.steered).toHaveLength(1)
  })
})
