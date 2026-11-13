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

  it('contains errors in the serial agent/created listener (never fails creation)', () => {
    const { ctx, tmp } = mount()
    const broken = {
      asCreated: () => ({
        get agent() { throw new Error('poisoned payload') },
        source: 'startup',
      }),
    }
    expect(() => ctx.emit('agent/created', broken.asCreated() as never)).not.toThrow()
    expect(ctx.warnings.join('\n')).toContain('agent/created session wiring failed')
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
