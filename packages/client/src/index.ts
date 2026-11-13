/**
 * The browser card entry for the Obsidian Mem settings card.
 *
 * In the scaffold this is the cordis plugin stub shape only: the lazy-CJS
 * bundle (scripts/build-client.mjs) stays switched off until the card source
 * lands with TASK-051, at which point this module re-exports the card's
 * `apply` and a `card.ts(x)` marker turns the bundler on.
 * @module dsh-plugin-obsidian-mem/client
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-client'
export const inject: string[] = []

/**
 * Wire the card into the host. The scaffold registers nothing; the card
 * mount lands with TASK-051.
 */
export function apply(ctx: Context): void {
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
