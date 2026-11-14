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

import { SYSTEM_PROMPT_SECTION_NAME, SYSTEM_PROMPT_SECTION_ORDER } from '../../core/lib/index.js'
import { describeError } from '../../service/lib/errors.js'

// Local structural mirror of the host `systemPrompt` seam slice (this
// package never imports dsh packages at runtime; PLAN TASK-031 canon).
export interface PromptSectionOptions {
  name: string
  order: number
  /** False: the assembler must not interpolate {{groups}} in the text. */
  interpolate?: boolean
  text: string | ((ctx: never) => string)
}

export interface SystemPromptSeam {
  section(options: PromptSectionOptions): unknown
}

/** The scoped-inject slice registerMemoryPromptSection needs. */
export interface MemoryPromptScope {
  systemPrompt: SystemPromptSeam
}

/**
 * MEMORY_PROMPT_SECTION_TEXT is the section body. Short by design: the
 * external budget for injected prose is small and every line here must
 * change WHEN the agent reaches for a memory tool, not HOW the tools work.
 */
export const MEMORY_PROMPT_SECTION_TEXT = `# Obsidian Mem

Five memory_* tools (read, search, write, audit, dream) provide access to shared
Markdown memory.

## Before starting real work
Before starting real work on a project or task, memory_search the vault
for prior decisions, gotchas, and settings tied to the project name.

## At the end of real work
At the end of real work, before presenting to the user run the completion
checkpoint: call the \`memory_audit\` tool with "checkpoint" as the view.

## FAQ
 - memory_audit is read-only and safe to run any time: when memory feels
   disorganized or before large vault cleanups. Its over-budget line names
   the compaction run to do next.
 - Vaults are shared across agents or read-only; managed in the Obsidian
   Mem settings card. Reads answer from every registered vault; writes go
   to shared vaults only.
`

/**
 * RegisterMemoryPromptSection registers the section through the scoped
 * systemPrompt seam. warn receives the provider's single degraded
 * message; the provider itself can only return text or ''.
 */
export function registerMemoryPromptSection(scope: MemoryPromptScope, warn: (message: string) => void): void {
  scope.systemPrompt.section({
    name: SYSTEM_PROMPT_SECTION_NAME,
    order: SYSTEM_PROMPT_SECTION_ORDER,
    interpolate: false,
    text: neverThrowingText(() => MEMORY_PROMPT_SECTION_TEXT, warn),
  })
}

/**
 * NeverThrowingText wraps a text provider: a throw becomes '' and exactly
 * one warn per provider instance, whatever the failure reason (the
 * assembler must never see an exception from a plugin section).
 */
export function neverThrowingText(source: () => string, warn: (message: string) => void): () => string {
  let warned = false
  return () => {
    try {
      return source()
    } catch (error: unknown) {
      if (!warned) {
        warned = true
        warn(`${SYSTEM_PROMPT_SECTION_NAME} system-prompt section unavailable: ${describeError(error)}`)
      }
      return ''
    }
  }
}
