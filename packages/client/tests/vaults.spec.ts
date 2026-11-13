/**
 * The Vaults section's pure render parts, driven through the react shim with
 * a recording fake (no DOM, no fetch, no primitives seed, so every control
 * takes its native fallback): the add form carries the global-file input
 * (placeholder + title hint verbatim, per the TASK-010 copy rule), and a
 * registry row renders path, source tag, mode tag, then the resolved
 * globalFile as a quiet tag before the remove control. Payload construction
 * (the globalFile omission rule) lives in api.spec.ts.
 * @module dsh-plugin-obsidian-mem/client/tests/vaults
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { StatusPayload } from '../src/api.ts'
import { setPrimitivesModule } from '../src/primitives.tsx'
import { setReactModule, type ReactLike } from '../src/react.ts'
import { VaultsSection } from '../src/sections/vaults.tsx'

interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** FakeReact records the element tree and serves hook state from slots. */
function fakeReact(): ReactLike {
  const slots: unknown[] = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) =>
      ({ type, props: (props ?? {}) as Record<string, unknown>, children }) as Element,
    Fragment: 'Fragment',
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
      const index = cursor
      cursor += 1
      if (!(index in slots)) {
        slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial
      }
      return [
        slots[index] as S,
        (next: S | ((prev: S) => S)) => {
          slots[index] = typeof next === 'function' ? (next as (prev: S) => S)(slots[index] as S) : next
        },
      ]
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor
      cursor += 1
      if (!(index in slots)) {
        slots[index] = { current: initialValue }
      }
      return slots[index] as { current: T }
    },
    useEffect: () => {},
  }
}

/** Render VaultsSection with fresh initial state and return its element tree. */
function render(status: Partial<StatusPayload>): Element {
  setReactModule(fakeReact())
  setPrimitivesModule(null)
  return VaultsSection({ status: status as StatusPayload, refresh: () => {} }) as unknown as Element
}

/** Descendants flattens the recorded tree: every element, Fragments spliced, child arrays recursed. */
function descendants(node: unknown): Element[] {
  if (Array.isArray(node)) {
    return node.flatMap((item) => descendants(item))
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return []
  }
  const element = node as Element
  if (element.type === 'Fragment') {
    return element.children.flatMap((child) => descendants(child))
  }
  return [element, ...element.children.flatMap((child) => descendants(child))]
}

function inputsWithPlaceholder(root: unknown, placeholder: string): Element[] {
  return descendants(root).filter(
    (element) => element.type === 'input' && element.props['placeholder'] === placeholder,
  )
}

const GLOBAL_FILE_PLACEHOLDER = 'Global memory relative file path e.g. GLOBAL.md'

beforeEach(() => {
  // The shim throws until a fake react is wired; null primitives keep the
  // native fallback renderers (plain 'input' / 'span' types) assertable.
  setReactModule(fakeReact())
  setPrimitivesModule(null)
})

describe('add form global-file input', () => {
  it('renders the TASK-010 placeholder and title hint verbatim', () => {
    const tree = render({ vaults: [], noticeActive: false, notice: null, defaultVaultPath: null })
    const inputs = inputsWithPlaceholder(tree, GLOBAL_FILE_PLACEHOLDER)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.props['title']).toBe(
      'Optional; relative to the vault root; blank defaults to GLOBAL.md',
    )
    // The field starts empty: the host default only applies when the key is
    // omitted, so the card must not prefill a value.
    expect(inputs[0]!.props['value']).toBe('')
  })
})

describe('registry row rendering', () => {
  const entry = {
    path: '/home/test/vault',
    mode: 'shared' as const,
    source: 'card' as const,
    globalFile: 'notes/global-memory.md',
  }

  it('shows the resolved globalFile as a tag after source and mode', () => {
    const tree = render({
      vaults: [entry],
      noticeActive: false,
      notice: null,
      defaultVaultPath: null,
    })
    // The vault row is the flex row whose children start with the mono path span.
    const row = descendants(tree).find(
      (element) => element.type === 'div'
        && element.children.some((child) => {
          const el = child as Element
          return el?.type === 'span' && el.children[0] === entry.path
        }),
    )!
    const texts = row.children
      .filter((child) => (child as Element).type === 'span')
      .map((child) => String((child as Element).children[0]))
    expect(texts).toEqual([entry.path, entry.source, entry.mode, entry.globalFile])
  })
})
