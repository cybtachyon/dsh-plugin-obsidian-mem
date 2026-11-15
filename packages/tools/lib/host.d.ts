/**
 * HostContract mirrors the exact model-facing tool contract the harness
 * `tools` seam accepts: `register(definition)` with raw JSON Schema
 * `parameters`/`output.schema`, a pure `render`, and `presentCall` card
 * views. Verified against the installed @deepseek-ai/cordis 4.1.0 plus the
 * live host `tools` service contract and @deepseek-ai/dsh-tools 0.2.1's
 * enforced JsonSchemaNode subset.
 *
 * This package never imports @deepseek-ai/dsh-tools at runtime (its module
 * scope may not resolve inside a third-party plugin's install, PLAN
 * TASK-031 canon), so the registration shapes are declared here and read
 * from the seam structurally. Arguments arrive `unknown`: the raw
 * definition path gets no defineTool-style validation, so every tool
 * parses and range-checks its own arguments in `execute`.
 * @module dsh-plugin-obsidian-mem/tools/host
 */
import type { Context } from '@deepseek-ai/cordis';
import type { NoteMeta } from '../../core/lib/index.js';
import type { AuditReport, AuditRequest } from '../../service/lib/audit.js';
import type { DreamEngineResult, DreamRequest } from '../../service/lib/dream.js';
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js';
import type { ObsidianMemReadResult, ObsidianMemWriteResult, ReadRegistryEntry, VaultEntry } from '../../service/lib/index.js';
export interface JsonSchemaNode {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    oneOf?: readonly JsonSchemaNode[];
    properties?: Readonly<Record<string, JsonSchemaNode>>;
    required?: readonly string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    enum?: readonly (string | number | boolean | null)[];
    const?: string | number | boolean | null;
    description?: string;
    title?: string;
}
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface ContentBlock {
    type: string;
    text: string;
}
/** The generic-card shapes presentCall returns (host presentation types). */
export interface GenericCallView {
    card: 'generic';
    title: string;
    kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';
    rawInput?: unknown;
}
/** The subset of the host ToolDefinition this package registers. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: JsonSchemaNode;
    output: {
        schema: JsonSchemaNode;
        render(args: unknown, value: JsonValue): ContentBlock[];
    };
    timeoutMs?: number;
    execute(args: unknown): Promise<unknown>;
    presentCall?(args: unknown): GenericCallView | undefined;
}
/** The `tools` seam slice the registration needs. */
export interface ToolsSeam {
    register(definition: ToolDefinition): () => void;
}
/** The scoped-inject scope: the Context plus the `tools` service. */
export type MemoryToolScope = Context & {
    tools: ToolsSeam;
    effect(execute: () => () => void, label?: string): unknown;
};
/**
 * MemoryService is the ctx.obsidianMem slice the memory_* tools consume.
 * The real ObsidianMemService satisfies it structurally; tests inject a
 * fake of the same shape.
 */
export interface MemoryService {
    /** Idempotent lazy provisioning; the trigger call returns the notice. */
    ensureMemoryAccess(): Promise<string | undefined>;
    /**
     * Write-path gate (TASK-003): awaits only the fast core provisioning and
     * boots the Milvus/indexer stack in the background; the trigger call
     * returns the notice.
     */
    ensureWriteAccess(): Promise<string | undefined>;
    listVaults(): VaultEntry[];
    read(absPath: string, options?: {
        offset?: number;
        limit?: number;
    }): Promise<ObsidianMemReadResult>;
    search(request: SearchRequest): Promise<MemorySearchResult[]>;
    readRecord(absPath: string): ReadRegistryEntry | undefined;
    applyWrite(path: string, meta: NoteMeta, body: string): Promise<ObsidianMemWriteResult>;
    /** Read-only doctor pass (memory_audit); never provisions, never writes. */
    audit(request?: AuditRequest): Promise<AuditReport>;
    /**
     * Dream: `plan` answers the deterministic analysis; `run` answers
     * {id, done} once the single-flight guard is armed. Busy and blocked
     * arrive as DreamBusyError / DreamBlockedError.
     */
    dream(request?: DreamRequest): Promise<DreamEngineResult>;
    readonly config: {
        budgets: {
            searchTopK: number;
            readSectionTokens: number;
        };
    };
}
export declare function requiredString(args: Record<string, unknown>, name: string): string;
export declare function optionalString(args: Record<string, unknown>, name: string): string | undefined;
export declare function optionalInt(args: Record<string, unknown>, name: string): number | undefined;
/** OptionalEnum accepts one of `allowed` verbatim; absent answers undefined. */
export declare function optionalEnum(args: Record<string, unknown>, name: string, allowed: readonly string[]): string | undefined;
export declare function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined;
/** ArgumentsRecord narrows the unknown execute payload once, centrally. */
export declare function asRecord(args: unknown): Record<string, unknown>;
/** TextBlock builds the one content block every render returns. */
export declare function textBlock(text: string): ContentBlock;
//# sourceMappingURL=host.d.ts.map
