/**
 * Plugin-shape spec for the ui row: the cordis mount surface (name, inject,
 * apply), the card contract surface, and the headless-profile rule. The
 * route behavior lives in ./routes.spec.ts.
 * @module dsh-plugin-obsidian-mem/ui/tests/ui
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import plugin, { apply, inject, name, ROUTES } from '../src/index.ts'
import { FakeCordisContext, makeRouteService } from './testkit.ts'

/**
 * The ui row mounts against the seam statically (like the tools and events
 * rows) and carries the /obsidian-mem/* route contract.
 */
describe('obsidian-mem ui package', () => {
  it('exports the cordis plugin shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(name).toBe('obsidian-mem-ui')
    expect(inject).toEqual(['obsidianMem'])
    expect(apply).toBeTypeOf('function')
    expect(plugin).toEqual({ name, inject, apply })
  })

  it('declares the full card contract with unique method+path pairs', () => {
    const seen = new Set<string>()
    for (const route of ROUTES) {
      expect(route.path.startsWith('/obsidian-mem/')).toBe(true)
      expect(route.description.length).toBeGreaterThan(0)
      const key = `${route.method} ${route.path}`
      expect(seen.has(key), `duplicate contract entry ${key}`).toBe(false)
      seen.add(key)
    }
    expect(ROUTES.length).toBe(15)
  })

  it('stays inert on a profile without the webServer service', () => {
    const context = new FakeCordisContext({
      obsidianMem: makeRouteService(),
      webServer: undefined,
    })
    expect(() => plugin.apply(context as unknown as Context)).not.toThrow()
    expect(context.webServer.records).toEqual([])
  })

  it('registers the routes when webServer and the seam are present', () => {
    const context = new FakeCordisContext({ obsidianMem: makeRouteService() })
    plugin.apply(context as unknown as Context)
    const paths = context.webServer.records.map((record) => record.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual([...new Set(ROUTES.map((route) => route.path))].sort())
  })
})
