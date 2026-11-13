/**
 * The client entry and bootstrap shape: the lazy-CJS factory exports, the
 * inert apply on a bare context, and the mount decision (the route probe
 * gates the slots registration; a react-less host logs the skip line
 * instead of throwing).
 * @module dsh-plugin-obsidian-mem/client/tests/client
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import plugin, { apply, inject, name } from '../src/index.ts'
import type { SlotsService } from '../src/plugin.ts'

interface FakeScope {
  slots: SlotsService
}

/** Fake slots service recording inject bodies and registrations. */
function fakeSlots() {
  const injected: string[] = []
  const registered: Array<{ spec: { name: string, key?: string }, component: unknown }> = []
  const slots: SlotsService = {
    inject: (slotName: string, body: () => void) => {
      injected.push(slotName)
      body()
    },
    register: (spec: { name: string, key?: string }, component: unknown) => {
      registered.push({ spec, component })
      return {}
    },
  }
  return { slots, injected, registered }
}

/** Fake plugin ctx whose scoped inject hands the body one fake scope. */
function fakeCtx(scope: FakeScope) {
  return {
    inject: (deps: string[], body: (scoped: unknown) => void) => {
      expect(deps).toEqual(['slots'])
      body(scope)
    },
  }
}

function stubStatusFetch(status: number): void {
  vi.stubGlobal('fetch', () => Promise.resolve({
    status,
    ok: status < 300,
    json: () => Promise.resolve({}),
  } as Response))
}

/** Flush the probe's promise chain (a macrotask turn drains the microtasks). */
async function settled(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('obsidian-mem client entry', () => {
  it('exports the lazy-CJS factory shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-client')
    expect(inject).toEqual([])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('applies as an inert no-op on a context without inject', () => {
    expect(() => apply({} as never)).not.toThrow()
  })
})

describe('card mount gating', () => {
  it('never reaches the slots seam when the host route probe misses (404)', async () => {
    stubStatusFetch(404)
    const { slots, injected, registered } = fakeSlots()
    apply(fakeCtx({ slots }) as never)
    await settled()
    expect(injected).toEqual([])
    expect(registered).toEqual([])
  })

  it('logs the skip line instead of throwing on a host without react', async () => {
    stubStatusFetch(200)
    const skip = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { slots, registered } = fakeSlots()
    apply(fakeCtx({ slots }) as never)
    await settled()
    // In this node test there is no ModuleLoader require, so the mount
    // throws into the skip logger; the browser case is covered by the
    // bundle-artifact assertions (dsh/client.js carries the ModuleLoader
    // contract and the two runtime requires).
    expect(registered).toEqual([])
    expect(skip.mock.calls.some(
      (call) => String(call[0]).includes('[obsidian-mem] settings card skipped'),
    )).toBe(true)
  })
})
