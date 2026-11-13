/**
 * Real @deepseek-ai/cordis 4.1.0 Context mount of the tools row (the
 * service package's cordis-mount.spec pattern): a carrier fiber provides
 * fake `obsidianMem` and `tools` services, `ctx.plugin(row)` starts the
 * row, and the scoped ctx.inject(['obsidianMem','tools'], …) must fire
 * exactly once, registering the three memory tools. Disposing the row
 * fiber runs the registration effects' disposers.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { TOOL_MEMORY_READ, TOOL_MEMORY_SEARCH } from '../../core/lib/index.js'
import plugin from '../src/index.ts'
import { createFakeService, createRecordingScope } from './testkit.ts'

describe('obsidian-mem tools on a real cordis Context', () => {
  const ctx = new Context()
  const service = createFakeService({ vaults: [] })
  const scope = createRecordingScope()

  it('mounts through ctx.plugin and registers all three tools', async () => {
    const carrier = await ctx.plugin({
      name: 'obsidian-mem-fakes',
      apply(carrierCtx: Context): void {
        carrierCtx.provide('obsidianMem', service as never)
        // The `tools` service is the object `scope.tools` exposes; the
        // recording scope's `.tools` member plays that service.
        carrierCtx.provide('tools', scope.tools as never)
      },
    })
    const fiber = await ctx.plugin(plugin)

    expect(scope.registered.map((definition) => definition.name))
      .toEqual([TOOL_MEMORY_READ, TOOL_MEMORY_SEARCH])

    // Unloading the row disposes its registration effects (the real
    // Context's effect machinery runs the register disposers in LIFO).
    await fiber.dispose()
    expect(scope.disposed).toEqual([TOOL_MEMORY_SEARCH, TOOL_MEMORY_READ])

    await carrier.dispose()
  })

  it('stays inert while the tools service is absent', async () => {
    const bare = new Context()
    const seamOnly = createFakeService({ vaults: [] })
    const lateScope = createRecordingScope()
    const seamCarrier = await bare.plugin({
      name: 'obsidian-mem-seam-only',
      apply(carrierCtx: Context): void {
        carrierCtx.provide('obsidianMem', seamOnly as never)
      },
    })
    // The row starts (its static inject is satisfied) but the scoped
    // inject never fires: no tools service exists.
    const fiber = await bare.plugin(plugin)
    expect(lateScope.registered).toEqual([])

    // A tools service arriving later wakes the scoped inject.
    const toolsCarrier = await bare.plugin({
      name: 'obsidian-mem-tools-late',
      apply(carrierCtx: Context): void {
        carrierCtx.provide('tools', lateScope.tools as never)
      },
    })
    // Fiber wakeups are async; poll briefly instead of guessing drains.
    for (let attempt = 0; attempt < 50 && lateScope.registered.length < 2; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(lateScope.registered.map((definition) => definition.name))
      .toEqual([TOOL_MEMORY_READ, TOOL_MEMORY_SEARCH])

    await toolsCarrier.dispose()
    await fiber.dispose()
    await seamCarrier.dispose()
  })
})
