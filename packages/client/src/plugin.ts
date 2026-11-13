/**
 * The browser card bootstrap: registerCard and mountCard.
 *
 * The Obsidian Mem config (vault registry, Dreaming triggers, index state)
 * had no way in from the browser; the card is contributed through a slot
 * rather than a settings schema: `plugins.bundle.config`, keyed by the
 * bundle's package name, on the Plugins page, with the `settings.plugin.item`
 * registration for older hosts. It reads and writes only the plugin's own
 * `/obsidian-mem/*` routes, so the browser never sees a value it did not
 * store.
 *
 * React and @deepseek-ai/dsh-client-ui-primitives come from the shell's
 * frozen platform module table (PLATFORM_MODULES): esbuild keeps the two
 * require calls external, so inside the lazy-CJS factory they resolve against
 * the injected require. A missing react skips the card (the throw is caught
 * by mountWhenRouteExists, which logs the skip line); a missing primitives
 * seed is a fallback, not an error, and the card renders with native controls.
 * @module dsh-plugin-obsidian-mem/client/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { routeExists } from './api.js'
import { createCard } from './card.js'
import type { PrimitivesModule } from './primitives.js'
import type { ReactLike } from './react.js'

// The require the lazy-CJS factory injects: the shell's frozen platform
// module table. esbuild keeps these calls bare in the CJS output, so inside
// the factory they resolve against the injected require, not node's.
declare const require: (name: string) => unknown

// The Plugins page dispatches a bundle's configuration by the bundle's
// manifest name (the root package.json "name" field): the key the package
// inventory uses for the plugins.bundle.config slot.
const PACKAGE_NAME = 'dsh-plugin-obsidian-mem'

/**
 * The slots service is dsh-specific and absent from the cordis Context type,
 * so the card narrows the scoped context to the members it needs.
 */
export interface SlotsService {
  /**
   * Wait until the named slot is declared, then run the body. The host calls
   * the body as a plain function (the working plugins register this way), so
   * a generator body is never driven and its register would not run.
   */
  inject(name: string, body: () => void): void
  /** Register a component into the named slot; returns the registration handle. */
  register(spec: SlotSpec, component: unknown): unknown
}

/** The slot registration spec: the slot name plus the host-specific keys. */
export interface SlotSpec {
  name: string
  key?: string
  id?: string
  order?: number
}

// The slots scope hands the card the slots service.
type SlotsScope = Context & { slots: SlotsService }

/**
 * RegisterCard wires the card through the slots seam. Reaching for an
 * undeclared service throws in cordis, so the seam rides a scoped
 * ctx.inject of its own and a profile without slots never mounts the card.
 */
function registerCard(ctx: Context): void {
  if (typeof ctx.inject !== 'function') {
    return
  }
  ctx.inject(['slots'], (scope) => {
    // Card and routes live and die together: with the host route absent (no
    // web profile) the card would only render an error, which is not what a
    // headless profile means. Any response but a 404 proves the route.
    mountWhenRouteExists('settings card', routeExists, () => {
      mountCard(scope as SlotsScope)
    })
  })
}

/**
 * MountWhenRouteExists runs the mount only after the route probe proves the
 * host serves the card's routes, and logs the card's skip line when the
 * mount throws (a react-absent host skips the card here, not at module load).
 */
function mountWhenRouteExists(
  label: string,
  probe: () => Promise<boolean>,
  mount: () => void,
): void {
  probe().then((exists) => {
    if (!exists) {
      return
    }
    try {
      mount()
    } catch (error) {
      console.error(`[obsidian-mem] ${label} skipped: ${String(error)}`)
    }
  })
}

/**
 * RequireRuntimeModules resolves the two runtime externals from the shell's
 * frozen platform module table. A missing react rethrows to
 * mountWhenRouteExists (skip line); a missing or partial primitives seed (no
 * Button) degrades to null, the native-control fallback.
 */
function requireRuntimeModules(): { react: unknown, primitives: PrimitivesModule | null } {
  const reactModule = require('react')
  let primitives: PrimitivesModule | null
  try {
    primitives = require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesModule
  } catch {
    primitives = null
  }
  if (primitives !== null && typeof primitives.Button !== 'function') {
    primitives = null
  }
  return { react: reactModule, primitives }
}

/**
 * MountCard resolves the runtime externals and registers the card into both
 * card slots. Each host fills the one it has: from dsh 0.1.6-alpha.2 on the
 * Plugins page declares plugins.bundle.config (keyed by the package name),
 * older ones only settings.plugin.item. A react-absent host rethrows to
 * mountWhenRouteExists, which logs the skip line.
 */
function mountCard(ctx: SlotsScope): void {
  const modules = requireRuntimeModules()
  const Card = createCard(modules.react as ReactLike, modules.primitives)
  ctx.slots.inject('plugins.bundle.config', () => {
    ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, Card)
  })
  ctx.slots.inject('settings.plugin.item', () => {
    ctx.slots.register(
      { name: 'settings.plugin.item', id: 'obsidian-mem', key: 'obsidian-mem', order: 42 },
      Card,
    )
  })
}

/**
 * Apply is the plugin entry point: it wires the card into the host. `slots`
 * is optional, so nothing is required here; registerCard takes it on its own
 * scoped inject.
 */
export function apply(ctx: Context): void {
  registerCard(ctx)
}
