import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'

import obsidianMem, { ObsidianMemService, withObsidianMemHooks } from '../src/index.ts'

/**
 * Context-mount smoke test on the real @deepseek-ai/cordis 4.1.0 devDep
 * (the scaffold's suggestion, mirroring the cordis-composition pattern):
 * `ctx.plugin()` the service row into a live Context with a `{}` config and
 * assert (a) the class-plugin form is what this cordis build activates,
 * (b) the static Config schema participates in activation (a bad enum value
 * fails the fiber with a ValidationError), and (c) the `obsidianMem` seam
 * resolves on the parent context afterwards. No driver services are needed,
 * so no scoping-down to a fake ctx was required.
 *
 * Hermetic mounts (TASK-016): cordis calls the class as `new callback(ctx,
 * config)` and cannot pass the constructor's hooks seam, so every mount here
 * uses {@link withObsidianMemHooks} to bind `homedir` to a per-file scratch
 * dir. Without it the service resolves the state registry under the real
 * `$HOME` and a machine with a provisioned default vault fails the
 * empty-registry assertion. Only the config-rejection mount (which never
 * constructs an instance) mounts the bare export; its identity assertions
 * still pin the row default export.
 */
describe('obsidianMem on a real cordis Context', () => {
  const scratchHome = mkdtempSync(join(tmpdir(), 'obsidian-mem-cordis-mount-'))
  afterAll(() => {
    rmSync(scratchHome, { recursive: true, force: true })
  })
  const isolatedMem = withObsidianMemHooks({ homedir: () => scratchHome })

  it('mounts through ctx.plugin and publishes the seam', async () => {
    const ctx = new Context()
    // The row default export is the class (Plugin.Constructor form).
    expect(typeof obsidianMem).toBe('function')
    expect(obsidianMem).toBe(ObsidianMemService)
    expect(obsidianMem.Config['~standard'].vendor).toBe('obsidian-mem')

    const fiber = await ctx.plugin(isolatedMem, {})
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
    // The bare export: its static Config is what the fiber validates against
    // (rejection happens before construction, so nothing reads scratch or
    // real home).
    await expect(ctx.plugin(obsidianMem, { vectorDim: 999 })).rejects.toThrow(/vectorDim/)
    // undefined config is a complete config: every default applies.
    const fiber = await ctx.plugin(isolatedMem)
    const seam = ctx.get('obsidianMem')
    expect(seam!.status().milvus.readinessTimeoutMs).toBe(600_000)
    await fiber.dispose()
  })

  it('mounts inertly below a missing service profile (static inject empty)', async () => {
    // The row has no inject entries, so a bare Context (no agents/schedule
    // or any other service) loads it exactly like the bundle profiles do;
    // the isolated row class inherits that static shape unchanged.
    const ctx = new Context()
    const fiber = await ctx.plugin(isolatedMem, {})
    expect(ctx.get('obsidianMem')).toBeInstanceOf(ObsidianMemService)
    await fiber.dispose()
  })
})
