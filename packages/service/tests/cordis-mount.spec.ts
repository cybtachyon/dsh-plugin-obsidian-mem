import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import obsidianMem, { ObsidianMemService } from '../src/index.ts'

/**
 * Context-mount smoke test on the real @deepseek-ai/cordis 4.1.0 devDep
 * (the scaffold's suggestion, mirroring the cordis-composition pattern):
 * `ctx.plugin()` the service row's default export into a live Context with
 * a `{}` config and assert (a) the class-plugin form is what this cordis
 * build activates, (b) the static Config schema participates in activation
 * (a bad enum value fails the fiber with a ValidationError), and (c) the
 * `obsidianMem` seam resolves on the parent context afterwards. No driver
 * services are needed, so no scoping-down to a fake ctx was required.
 */
describe('obsidianMem on a real cordis Context', () => {
  it('mounts through ctx.plugin and publishes the seam', async () => {
    const ctx = new Context()
    // The row default export is the class (Plugin.Constructor form).
    expect(typeof obsidianMem).toBe('function')
    expect(obsidianMem).toBe(ObsidianMemService)
    expect(obsidianMem.Config['~standard'].vendor).toBe('obsidian-mem')

    const fiber = await ctx.plugin(obsidianMem, {})
    const seam = ctx.get('obsidianMem')
    expect(seam).toBeInstanceOf(ObsidianMemService)
    // Activation stayed side-effect free: an empty registry, nothing built.
    expect(seam!.listVaults()).toEqual([])
    expect(seam!.status().state).toBe('inactive')

    await fiber.dispose()
    expect(ctx.get('obsidianMem')).toBeUndefined()
  })

  it('validates the row config with the standard-schema at activation', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(obsidianMem, { vectorDim: 999 })).rejects.toThrow(/vectorDim/)
    // undefined config is a complete config: every default applies.
    const fiber = await ctx.plugin(obsidianMem)
    const seam = ctx.get('obsidianMem')
    expect(seam!.status().milvus.readinessTimeoutMs).toBe(600_000)
    await fiber.dispose()
  })

  it('mounts inertly below a missing service profile (static inject empty)', async () => {
    // The row has no inject entries, so a bare Context (no agents/schedule
    // or any other service) loads it exactly like the bundle profiles do.
    const ctx = new Context()
    const fiber = await ctx.plugin(obsidianMem, {})
    expect(ctx.get('obsidianMem')).toBeInstanceOf(ObsidianMemService)
    await fiber.dispose()
  })
})
