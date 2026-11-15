import { existsSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { join } from 'node:path'
import plugin, { apply, inject, mountLifecycle, name } from '../src/index.ts'
import { SESSIONS_FILE_NAME } from '../src/sessions.ts'
import { fakeAgent, fakeEventsCtx, fakeMemory, tempDbPath } from './testkit.ts'

/**
 * Row-shape and lifecycle-wiring specs (TASK-040): the plugin exports the
 * cordis shape, apply defers to a scoped inject so a profile without the
 * `agents` service loads inertly, and mountLifecycle owns the session
 * registry (seam wiring, subagent detection, containment of the serial
 * agent/created listener, teardown).
 */

describe('obsidian-mem events package', () => {
  it('exports the cordis plugin shape with the seam inject', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-events')
    expect(inject).toEqual(['obsidianMem'])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies through a scoped inject and loads inertly without the agents service', () => {
    const injectCalls: Array<readonly string[]> = []
    const ctx = {
      inject: (deps: readonly string[]) => { injectCalls.push(deps) },
    }
    expect(() => apply(ctx as never)).not.toThrow()
    expect(injectCalls).toEqual([['obsidianMem', 'agents']])
  })
})

describe('mountLifecycle (session registry wiring)', () => {
  function mount() {
    const tmp = tempDbPath()
    const memory = fakeMemory({ dbPath: tmp.dir })
    const ctx = fakeEventsCtx(memory)
    const registry = mountLifecycle(ctx.scope)
    return { tmp, memory, ctx, registry }
  }

  it('constructs the registry and wires it onto the seam', () => {
    const { memory, registry, tmp } = mount()
    expect(memory.registryWires).toEqual([registry])
    expect(registry.shouldInject('s1', 'note')).toBe(true)
    // The ledger path is <dbPath>/state/sessions.json (nothing written yet:
    // an untouched store creates no file).
    expect(existsSync(join(tmp.dir, 'state', SESSIONS_FILE_NAME))).toBe(false)
    tmp.cleanup()
  })

  it('records sessions on agent/created, subagent flag included', () => {
    const { ctx, registry, tmp } = mount()
    const parent = fakeAgent({ id: 'session-parent' })
    const child = fakeAgent({ id: 'session-child', origin: 'subagent' })
    const deep = fakeAgent({ id: 'session-deep', delegationDepth: 2 })
    ctx.emit('agent/created', parent.asCreated())
    ctx.emit('agent/created', child.asCreated())
    ctx.emit('agent/created', deep.asCreated())
    expect(registry.isSubagent('session-parent')).toBe(false)
    expect(registry.isSubagent('session-child')).toBe(true)
    expect(registry.isSubagent('session-deep')).toBe(true)
    tmp.cleanup()
  })

  it('registers exactly the turn-start and Think listeners per agent and no turn-stopping (TASK-010)', () => {
    const { ctx, tmp } = mount()
    const agent = fakeAgent({ id: 'session-1' })
    ctx.emit('agent/created', agent.asCreated())
    expect([...agent.agentHandlers.keys()].sort()).toEqual([
      'agent/assistant-stream',
      'agent/pre-step',
    ])
    // Plugin ctx: the three tools/result observers (read intercept, memory
    // watch, write ledger); the watch is all that rides turn end.
    expect(ctx.handlers.get('tools/result') ?? []).toHaveLength(3)
    tmp.cleanup()
  })

  it('lineages the dream- session, installs no agent-scoped listeners, disposes cleanly (TASK-004)', () => {
    const { ctx, registry, tmp } = mount()
    const dream = fakeAgent({ id: 'dream-run-1' })
    ctx.emit('agent/created', dream.asCreated())
    expect(registry.isDreamLineage('dream-run-1')).toBe(true)
    expect([...dream.agentHandlers.keys()]).toEqual([])
    expect(dream.agentEffects).toHaveLength(0)
    // No disposer was registered for the lineaged agent; disposal stays clean.
    expect(() => ctx.emit('agent/disposed', dream.asDisposed())).not.toThrow()
    expect(ctx.warnings).toEqual([])
    tmp.cleanup()
  })

  it('lineages descendants through parentSession at unbounded depth (TASK-004)', () => {
    const { ctx, registry, tmp } = mount()
    const dream = fakeAgent({ id: 'dream-run-1' })
    const child = fakeAgent({ id: 'c-1', parentSession: 'dream-run-1' })
    const grandchild = fakeAgent({ id: 'g-1', parentSession: 'c-1' })
    ctx.emit('agent/created', dream.asCreated())
    ctx.emit('agent/created', child.asCreated())
    ctx.emit('agent/created', grandchild.asCreated())
    expect(registry.isDreamLineage('c-1')).toBe(true)
    expect(registry.isDreamLineage('g-1')).toBe(true)
    expect([...child.agentHandlers.keys()]).toEqual([])
    expect([...grandchild.agentHandlers.keys()]).toEqual([])
    tmp.cleanup()
  })

  it('installs the hooks for unrelated siblings and unknown-parent sessions (TASK-004)', () => {
    const { ctx, registry, tmp } = mount()
    const dream = fakeAgent({ id: 'dream-run-1' })
    const sibling = fakeAgent({ id: 'session-sib' })
    const orphan = fakeAgent({ id: 'session-orphan', parentSession: 'never-created' })
    ctx.emit('agent/created', dream.asCreated())
    ctx.emit('agent/created', sibling.asCreated())
    ctx.emit('agent/created', orphan.asCreated())
    expect(registry.isDreamLineage('session-sib')).toBe(false)
    expect(registry.isDreamLineage('session-orphan')).toBe(false)
    for (const agent of [sibling, orphan]) {
      expect([...agent.agentHandlers.keys()].sort()).toEqual([
        'agent/assistant-stream',
        'agent/pre-step',
      ])
    }
    tmp.cleanup()
  })

  it('contains errors in the serial agent/created listener (never fails creation)', () => {
    const { ctx, tmp } = mount()
    const broken = {
      asCreated: () => ({
        get agent() { throw new Error('poisoned payload') },
        source: 'startup',
      }),
    }
    expect(() => ctx.emit('agent/created', broken.asCreated() as never)).not.toThrow()
    expect(ctx.warnings.join('\n')).toContain('agent/created wiring failed')
    tmp.cleanup()
  })

  it('drops the live record on agent/disposed but keeps the persisted ledger', () => {
    const { ctx, registry, tmp } = mount()
    const agent = fakeAgent({ id: 'session-1' })
    ctx.emit('agent/created', agent.asCreated())
    registry.addRecallTokens('session-1', 10)
    registry.markInjected('session-1', 'note')
    expect(registry.totalRecallTokensUsed()).toBe(10)

    ctx.emit('agent/disposed', agent.asDisposed())
    // Live bookkeeping died with the agent; the once-per-session ledger row
    // survives the flush on close.
    expect(registry.totalRecallTokensUsed()).toBe(0)
    expect(registry.shouldInject('session-1', 'note')).toBe(false)
    registry.flush()
    expect(existsSync(join(tmp.dir, 'state', SESSIONS_FILE_NAME))).toBe(true)
    tmp.cleanup()
  })

  it('unwires the seam and closes the registry when the plugin fiber unloads', () => {
    const { ctx, memory, tmp } = mount()
    expect(ctx.effectDisposers.length).toBeGreaterThanOrEqual(2)
    for (const dispose of ctx.effectDisposers) dispose()
    expect(memory.registryWires.at(-1)).toBeNull()
    tmp.cleanup()
  })

  it('flushes the ledger on unload (fiber dispose writes sessions.json)', () => {
    const { ctx, registry, tmp } = mount()
    registry.markInjected('session-9', 'note')
    for (const dispose of ctx.effectDisposers) dispose()
    expect(existsSync(join(tmp.dir, 'state', SESSIONS_FILE_NAME))).toBe(true)
    rmSync(tmp.dir, { recursive: true, force: true })
  })
})
