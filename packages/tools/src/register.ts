/**
 * Registration pass for the memory_* tools: each definition is registered
 * through the scoped `tools` service inside a `ctx.effect`, so unloading
 * the row (or the tools service changing) disposes every registration
 * through the disposer `register` hands back. The tool set lands here in
 * registration order (write, audit, and dream join in TASK-033..035).
 * @module dsh-plugin-obsidian-mem/tools/register
 */

import type { MemoryService, MemoryToolScope } from './host.js'
import { createReadTool } from './read.js'
import { createSearchTool } from './search.js'

/** Register the model-facing tools against one scoped tools+seam scope. */
export function registerMemoryTools(scope: MemoryToolScope, service: MemoryService): void {
  for (const definition of [
    createReadTool(service),
    createSearchTool(service),
  ]) {
    scope.effect(
      () => scope.tools.register(definition),
      `obsidian-mem-tools.${definition.name}`,
    )
  }
}
