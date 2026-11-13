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
// Argument parsing helpers: raw definitions receive `unknown` args, so
// each tool normalizes through these one-per-field guards. A missing or
// wrong-typed required field throws (the host materializes the throw as an
// error result the model can read); optional numbers clamp.
export function requiredString(args, name) {
    const value = args[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`obsidian-mem tool: "${name}" must be a non-empty string`);
    }
    return value;
}
export function optionalString(args, name) {
    const value = args[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`obsidian-mem tool: "${name}" must be a string when provided`);
    }
    return value.trim() === '' ? undefined : value.trim();
}
export function optionalInt(args, name) {
    const value = args[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`obsidian-mem tool: "${name}" must be a number when provided`);
    }
    return Math.trunc(value);
}
/** OptionalEnum accepts one of `allowed` verbatim; absent answers undefined. */
export function optionalEnum(args, name, allowed) {
    const value = args[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`obsidian-mem tool: "${name}" must be one of ${allowed.join(' | ')}`);
    }
    return value;
}
export function optionalBoolean(args, name) {
    const value = args[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`obsidian-mem tool: "${name}" must be a boolean when provided`);
    }
    return value;
}
/** ArgumentsRecord narrows the unknown execute payload once, centrally. */
export function asRecord(args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('obsidian-mem tool: arguments must be an object');
    }
    return args;
}
/** TextBlock builds the one content block every render returns. */
export function textBlock(text) {
    return { type: 'text', text };
}
//# sourceMappingURL=host.js.map
