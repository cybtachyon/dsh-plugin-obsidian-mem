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
export declare const MEMORY_PROMPT_SECTION_TEXT = "# Obsidian Mem\n\nFive memory_* tools (read, search, write, audit, dream) provide access to shared\nmarkdown memory.\n\n- Before starting real work on a project or task, memory_search the vault\n  for prior decisions, gotchas, and settings tied to the project name.\n- Before writing a new note, memory_search for a note that already covers\n  the fact. Settled facts accumulate by update, not by accumulation:\n  memory_read the existing note and memory_write the same path with the\n  corrected content instead of writing a second, contradicting note.\n- Save once a fact is settled (a decision made, a bug root-caused, a\n  stated user preference), not mid-speculation. If the note would only\n  restate the current conversation, it is not settled yet.\n- At the end of a task, run the completion checkpoint: promote what this\n  session settled, retire what was transient, and write nothing when\n  nothing qualifies (an empty checkpoint still has to be decided).\n- Never store secret values (tokens, passwords, api keys). Store where a\n  secret lives, never the secret itself.\n- Retire notes by archiving (memory_write with the archive flag), never\n  by deleting files; archived notes stay out of recall.\n- memory_audit is read-only and safe to run any time: when memory feels\n  disorganized or before large vault cleanups. Its over-budget line names\n  the compaction run to do next.\n- Vaults are shared across agents or read-only; managed in the Obsidian\n  Mem settings card. Reads answer from every registered vault; writes go\n  to shared vaults only.";
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
