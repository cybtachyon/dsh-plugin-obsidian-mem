/**
 * Registration pass for the memory_* tools: each definition is registered
 * through the scoped `tools` service inside a `ctx.effect`, so unloading
 * the row (or the tools service changing) disposes every registration
 * through the disposer `register` hands back. The tool set lands here in
 * registration order: memory_read, memory_search, memory_write,
 * memory_audit, memory_dream.
 * @module dsh-plugin-obsidian-mem/tools/register
 */

import type { MemoryService, MemoryToolScope } from './host.js'
import { createAuditTool } from './audit.js'
import { createDreamTool } from './dream.js'
import { createReadTool } from './read.js'
import { createSearchTool } from './search.js'
import { createWriteTool } from './write.js'

/** Register the model-facing tools against one scoped tools+seam scope. */
export function registerMemoryTools(scope: MemoryToolScope, service: MemoryService): void {
  for (const definition of [
    createReadTool(service),
    createSearchTool(service),
    createWriteTool(service),
    createAuditTool(service),
    createDreamTool(service),
  ]) {
    scope.effect(
      () => scope.tools.register(definition),
      `obsidian-mem-tools.${definition.name}`,
    )
  }
}
