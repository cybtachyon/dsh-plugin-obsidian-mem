/**
 * The `obsidian-mem` system-prompt section (TASK-036): cross-tool workflow
 * TIMING only. Per the agent-experience canon (say each fact once), the
 * section deliberately omits what the five tool definitions already own:
 * write preconditions and the Why:/index_description note format live in
 * memory_write's description and parameters, and the memory_dream usage
 * timing plus the scheduling offer live in memory_dream's description.
 *
 * Registration shape (verified against dsh-system-prompt 0.2.1 via the
 * engramory-ext pattern): `systemPrompt.section({name, order,
 * interpolate:false, text})` inside a scoped inject. `interpolate:false`
 * is load-bearing: the assembler interpolates by default and throws on
 * unknown {{groups}}. The text provider never throws: missing data comes
 * back as '' with one warn, so a degraded section just disappears from
 * the prompt instead of breaking assembly.
 * @module dsh-plugin-obsidian-mem/tools/prompt
 */
export interface PromptSectionOptions {
    name: string;
    order: number;
    /** False: the assembler must not interpolate {{groups}} in the text. */
    interpolate?: boolean;
    text: string | ((ctx: never) => string);
}
export interface SystemPromptSeam {
    section(options: PromptSectionOptions): unknown;
}
/** The scoped-inject slice registerMemoryPromptSection needs. */
export interface MemoryPromptScope {
    systemPrompt: SystemPromptSeam;
}
/**
 * MEMORY_PROMPT_SECTION_TEXT is the section body. Short by design: the
 * external budget for injected prose is small and every line here must
 * change WHEN the agent reaches for a memory tool, not HOW the tools work.
 */
export declare const MEMORY_PROMPT_SECTION_TEXT = "# Obsidian Mem\n\nFive memory_* tools (read, search, write, audit, dream) provide access to shared\nMarkdown memory.\n\n## Before starting real work\nBefore starting real work on a project or task, memory_search the vault\nfor prior decisions, gotchas, and settings tied to the project name.\n\n## At the end of real work\nAt the end of real work, before presenting to the user run the completion\ncheckpoint: call the `memory_audit` tool with \"checkpoint\" as the view.\n\n## FAQ\n - memory_audit is read-only and safe to run any time: when memory feels\n   disorganized or before large vault cleanups. Its over-budget line names\n   the compaction run to do next.\n - Vaults are shared across agents or read-only; managed in the Obsidian\n   Mem settings card. Reads answer from every registered vault; writes go\n   to shared vaults only.\n";
/**
 * RegisterMemoryPromptSection registers the section through the scoped
 * systemPrompt seam. warn receives the provider's single degraded
 * message; the provider itself can only return text or ''.
 */
export declare function registerMemoryPromptSection(scope: MemoryPromptScope, warn: (message: string) => void): void;
/**
 * NeverThrowingText wraps a text provider: a throw becomes '' and exactly
 * one warn per provider instance, whatever the failure reason (the
 * assembler must never see an exception from a plugin section).
 */
export declare function neverThrowingText(source: () => string, warn: (message: string) => void): () => string;
//# sourceMappingURL=prompt.d.ts.map
