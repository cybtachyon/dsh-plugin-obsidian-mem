/**
 * The model-facing tools for the Obsidian Mem capability: `memory_read`,
 * `memory_search`, `memory_write`, `memory_audit`, and `memory_dream` are
 * registered here (alongside the system-prompt timing section), each with
 * its own timeout budget and assembled from the shared toolkit in
 * ./toolkit.js.
 *
 * Mount shape (verified against the installed @deepseek-ai/cordis 4.1.0
 * and the live host `tools` service contract): the static `inject` pins
 * the `obsidianMem` seam, and `apply` runs a scoped
 * `ctx.inject(['obsidianMem', 'tools'], …)` so a profile that disables the
 * tools service still loads the row inertly. `scope.tools` is read through
 * the local structural mirror in ./host.js (this package never imports
 * @deepseek-ai/dsh-tools at runtime; PLAN TASK-031 canon). Each tool
 * answers through a closed `oneOf` output keyed on `kind`: expected
 * failures are return values, never throws.
 * @module dsh-plugin-obsidian-mem/tools
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "obsidian-mem-tools";
export declare const inject: string[];
/**
 * Mount the model-facing tools and the system-prompt section: the first
 * scoped inject waits for the memory seam plus the host `tools` service,
 * then registers every memory_* tool inside fiber effects; the second
 * waits for the memory seam plus the host `systemPrompt` service and
 * registers the cross-tool timing section. Either half stays inert while
 * its service is absent.
 */
export declare function apply(ctx: Context): void;
declare const plugin: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default plugin;
export { registerMemoryTools } from './register.js';
export { createReadTool, executeRead, READ_DESCRIPTION, READ_OUTPUT, READ_PARAMETERS, READ_TIMEOUT_MS, renderRead, } from './read.js';
export type { ReadValue } from './read.js';
export { createSearchTool, executeSearch, INDEX_OFFLINE_REMEDIATION, renderSearch, SEARCH_DESCRIPTION, SEARCH_OUTPUT, SEARCH_TIMEOUT_MS, searchParameters, } from './search.js';
export type { SearchSection, SearchValue } from './search.js';
export { createWriteTool, executeWrite, renderWrite, WRITE_DESCRIPTION, WRITE_OUTPUT, WRITE_PARAMETERS, WRITE_TIMEOUT_MS, } from './write.js';
export type { WriteValue } from './write.js';
export { createAuditTool, executeAudit, renderAudit, AUDIT_DESCRIPTION, AUDIT_OUTPUT, AUDIT_PARAMETERS, AUDIT_TIMEOUT_MS, } from './audit.js';
export type { AuditValue } from './audit.js';
export { createDreamTool, executeDream, renderDream, DREAM_DESCRIPTION, DREAM_OUTPUT, DREAM_PARAMETERS, DREAM_TIMEOUT_MS, } from './dream.js';
export type { DreamValue } from './dream.js';
export { registerMemoryPromptSection, neverThrowingText, MEMORY_PROMPT_SECTION_TEXT, } from './prompt.js';
export type { MemoryPromptScope, PromptSectionOptions, SystemPromptSeam, } from './prompt.js';
export type { JsonSchemaNode, MemoryService, MemoryToolScope, ToolDefinition, ToolsSeam, } from './host.js';
//# sourceMappingURL=index.d.ts.map
