/**
 * Shared test kit for the client card specs: the fake react that records the
 * element tree, serves hook state from slots, and runs useEffect with the
 * real one's dependency comparison (a stable dep list runs the effect once,
 * changed deps clean up before rerun), plus the element type and the
 * descendant flattener every spec asserts through.
 * @module dsh-plugin-obsidian-mem/client/tests/testkit
 */

import type { ReactLike } from '../src/react.ts'

/** Element is one recorded createElement call: its type, props, and children. */
export interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** FakeReact holds the fake plus the two drivers specs need. */
export interface FakeReact {
  react: ReactLike
  /** begin resets the hook cursor for one more manual render pass. */
  begin: () => void
  /** dispose runs every live effect cleanup (timers especially). */
  dispose: () => void
}

/**
 * FakeReact records the element tree, serves hook state from slots, and runs
 * useEffect with the real one's dependency comparison: a stable dep list runs
 * the effect once (the mount fetch), changed deps clean up before rerun, so a
 * timer effect never duplicates within a test or outlives it. A spec that
 * wants fresh hook state per render builds a new fake per render instead.
 */
export function fakeReact(): FakeReact {
  const slots: unknown[] = []
  const effects: Array<{ deps: readonly unknown[] | undefined, cleanup?: () => void } | undefined> = []
  let cursor = 0
  const react: ReactLike = {
    createElement: (type, props, ...children) =>
      ({ type, props: (props ?? {}) as Record<string, unknown>, children }) as unknown as Element,
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
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
      const index = cursor
      cursor += 1
      const stored = effects[index]
      const unchanged = stored !== undefined && stored.deps !== undefined && deps !== undefined
        && stored.deps.length === deps.length
        && stored.deps.every((value, at) => Object.is(value, deps[at]))
      if (unchanged) {
        return
      }
      stored?.cleanup?.()
      const cleanup = effect()
      effects[index] = { deps, ...(cleanup === undefined ? {} : { cleanup }) }
    },
  }
  return {
    react,
    begin: () => {
      cursor = 0
    },
    dispose: () => {
      for (const effect of effects) {
        effect?.cleanup?.()
      }
      effects.length = 0
    },
  }
}

/** Descendants flattens the recorded tree: every element, Fragments spliced, child arrays recursed. */
export function descendants(node: unknown): Element[] {
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
