/**
 * System-prompt section spec (TASK-036 DoD): the section registers through
 * the scoped systemPrompt seam with the fixed name, the external-range
 * order 9600, interpolate:false, a text snapshot, and a provider that
 * turns failures into '' plus exactly one warn. The plugin row must also
 * stay inert (no throw) when the systemPrompt service never answers.
 */

import { describe, expect, it } from 'vitest'

import { SYSTEM_PROMPT_SECTION_NAME, SYSTEM_PROMPT_SECTION_ORDER } from '../../core/lib/index.js'
import plugin, { neverThrowingText, registerMemoryPromptSection } from '../src/index.ts'
import type { PromptSectionOptions } from '../src/index.ts'

function fakeScope() {
  const sections: PromptSectionOptions[] = []
  return {
    scope: { systemPrompt: { section: (options: PromptSectionOptions) => { sections.push(options) } } },
    sections,
  }
}

describe('registerMemoryPromptSection', () => {
  it('registers the fixed name, external order, and interpolate:false', () => {
    const { scope, sections } = fakeScope()
    registerMemoryPromptSection(scope, () => undefined)
    expect(sections).toHaveLength(1)
    const section = sections[0] as PromptSectionOptions
    expect(section.name).toBe(SYSTEM_PROMPT_SECTION_NAME)
    expect(section.order).toBe(9600)
    expect(SYSTEM_PROMPT_SECTION_ORDER).toBe(9600)
    expect(section.interpolate).toBe(false)
    expect(typeof section.text).toBe('function')
  })

  it('answers the section text verbatim (cross-tool timing only)', () => {
    const { scope, sections } = fakeScope()
    registerMemoryPromptSection(scope, () => undefined)
    const [registered] = sections
    if (registered === undefined || typeof registered.text !== 'function') {
      throw new Error('expected one registered function-text section')
    }
    const text = registered.text(undefined as never)
    // Snapshot of the prepared MEMORY_PROMPT_SECTION_TEXT bytes (the
    // user's prompt is the source of truth): refresh the snapshot with
    // `-u` when the section changes; never edit the constant.
    expect(text).toMatchSnapshot()
    expect(text).toContain('memory_search')
    expect(text).toContain('"checkpoint" as the view')
    expect(text).toContain('Vaults are shared across agents')
    // Say-once: facts that live in tool descriptions or the audit
    // checkpoint view's instructions stay out here.
    expect(text).not.toContain('memory_dream run')
    expect(text).not.toContain('Automated dreaming can be scheduled')
    expect(text).not.toContain('Never store secret values')
    expect(text).not.toContain('{{')
    expect(text.split('\n').length).toBeLessThan(180)
  })
})

describe('neverThrowingText', () => {
  it('degrades to empty text with exactly one warn per provider', () => {
    const warnings: string[] = []
    const provider = neverThrowingText(
      () => {
        throw new Error('vault scan exploded')
      },
      (message) => {
        warnings.push(message)
      },
    )
    expect(provider()).toBe('')
    expect(provider()).toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('obsidian-mem')
    expect(warnings[0]).toContain('vault scan exploded')
  })

  it('passes healthy text through untouched', () => {
    expect(neverThrowingText(() => 'body', () => undefined)()).toBe('body')
  })
})

describe('plugin row mounts the section without the host services', () => {
  it('declares two scoped injects and stays inert when neither answers', () => {
    const injected: string[][] = []
    const ctx = {
      inject: (deps: string[], _apply: unknown) => {
        injected.push([...deps])
      },
    }
    // apply must not throw when no service ever calls back (inert row).
    plugin.apply(ctx as never)
    expect(injected).toEqual([
      ['obsidianMem', 'tools'],
      ['obsidianMem', 'systemPrompt'],
    ])
  })
})
