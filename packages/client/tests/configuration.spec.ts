/**
 * The Configuration section driven through the react shim with a recording
 * fetch stub and no primitives seed (native fallbacks everywhere): the GET
 * answer seeds the drafts, overridden knobs carry the "custom" badge, the
 * blank-field rules hold (a blank number sends nothing; a blanked custom
 * text field unsets its override), the keyword-LLM rows gate on the toggle,
 * reset is two-step and DELETEs, and restartPending renders the chip plus
 * the banner. The fake react runs effects with the real one's dependency
 * comparison, so the mount fetch stays a one-shot and the toast timer is
 * reachable through the effect cleanup on dispose.
 * @module dsh-plugin-obsidian-mem/client/tests/configuration
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CardEditableConfig, CardSettingsView } from '../../service/lib/index.js'
import { CARD_SETTINGS_KEYS } from '../../service/lib/index.js'
import type { CardSettingsPayload } from '../src/api.ts'
import { setPrimitivesModule } from '../src/primitives.tsx'
import { setReactModule, type ReactLike } from '../src/react.ts'
import {
  buildSettingsPatch,
  CONFIG_FIELDS,
  ConfigurationSection,
  type ConfigFieldDraft,
} from '../src/sections/configuration.tsx'

interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface FakeReact {
  react: ReactLike
  /** begin resets the hook cursor for one more manual render pass. */
  begin: () => void
  /** dispose runs every live effect cleanup (the toast timer especially). */
  dispose: () => void
}

// FakeReact records the element tree, serves hook state from slots, and runs
// useEffect with the real one's dep comparison: a stable dep list runs the
// effect once (the mount fetch), changed deps clean up before rerun, so the
// toast timer never duplicates within a test or outlives it.
function fakeReact(): FakeReact {
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

// liveFake holds the mounted fake so afterEach can run its effect cleanups
// (a mounted component with a visible toast owns a 4 s timer).
let liveFake: FakeReact | null = null

afterEach(() => {
  liveFake?.dispose()
  liveFake = null
  vi.unstubAllGlobals()
})

/** renderPass wires the fake react, drops the primitives seed, and renders once. */
function renderPass(fake: FakeReact): Element {
  setReactModule(fake.react)
  setPrimitivesModule(null)
  fake.begin()
  return ConfigurationSection() as unknown as Element
}

interface Answer {
  status: number
  body: unknown
}

interface RecordedCall {
  method: string
  url: string
  body: unknown
}

/** StubSettings answers the three settings routes from canned replies and records every call. */
function stubSettings(answers: { get: Answer, post?: Answer, del?: Answer }): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    calls.push({
      method,
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    })
    const answer = method === 'POST'
      ? answers.post ?? { status: 200, body: view() }
      : method === 'DELETE'
        ? answers.del ?? { status: 200, body: view() }
        : answers.get
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: () => Promise.resolve(answer.body),
    } as Response)
  })
  return calls
}

/** Mount renders once, drains the GET promise chain, and hands back a re-render thunk. */
async function mount(answers: { get: Answer, post?: Answer, del?: Answer }): Promise<{
  calls: RecordedCall[]
  render: () => Element
}> {
  const calls = stubSettings(answers)
  const fake = fakeReact()
  liveFake = fake
  renderPass(fake)
  await flush()
  return { calls, render: () => renderPass(fake) }
}

/** flush drains the stubbed fetch promises and their .then chains. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Descendants flattens the recorded tree: every element, Fragments spliced. */
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

function inputByTitle(root: unknown, title: string): Element {
  const found = descendants(root).find(
    (element) => element.type === 'input' && element.props['title'] === title,
  )
  expect(found, `input titled "${title}"`).toBeDefined()
  return found!
}

function selectByLabel(root: unknown, label: string): Element {
  const found = descendants(root).find(
    (element) => element.type === 'select' && element.props['aria-label'] === label,
  )
  expect(found, `select labeled "${label}"`).toBeDefined()
  return found!
}

function buttonByLabel(root: unknown, label: string): Element {
  const found = descendants(root).find(
    (element) => element.type === 'button' && element.children[0] === label,
  )
  expect(found, `button "${label}"`).toBeDefined()
  return found!
}

function divTexts(root: unknown): unknown[] {
  return descendants(root)
    .filter((element) => element.type === 'div')
    .map((element) => element.children[0])
}

function spanTexts(root: unknown): unknown[] {
  return descendants(root)
    .filter((element) => element.type === 'span')
    .map((element) => element.children[0])
}

function click(element: Element): void {
  (element.props['onClick'] as () => void)()
}

function setInput(element: Element, value: string): void {
  (element.props['onChange'] as (event: unknown) => void)({ target: { value } })
}

const SETTINGS: CardEditableConfig = {
  vectorDim: 384,
  model: { id: 'Xenova/multilingual-e5-small', cacheDir: '/home/test/.dsh/obsidian-mem-db/models' },
  milvus: { dbPath: '/home/test/.dsh/obsidian-mem-db' },
  budgets: {
    turnStartRecallTokens: 1200,
    globalMemoryTokens: 1500,
    readSections: 2,
    readSectionTokens: 350,
    searchTopK: 6,
    thinkShotsPerTurn: 3,
  },
  llm: { enabled: false, baseUrl: '', model: '', apiKeyEnv: '' },
}

function view(overrides: Partial<CardSettingsView> = {}): CardSettingsPayload {
  return { settings: SETTINGS, overrides: {}, restartPending: [], ...overrides }
}

function ok(overrides: Partial<CardSettingsView> = {}): Answer {
  return { status: 200, body: view(overrides) }
}

const TOP_K_TITLE = 'Result count memory_search returns when the caller omits topK'
const READ_SECTIONS_TITLE = 'Most sections a Read-tool recall may inject'
const CACHE_DIR_TITLE = 'Directory transformers.js reads and downloads the model in'
const MODEL_ID_TITLE = 'ONNX model id used to embed every note'
const BASE_URL_TITLE = 'OpenAI-compatible endpoint base URL'

describe('whitelist and field table', () => {
  it('covers exactly the service CARD_SETTINGS_KEYS paths', () => {
    expect(CONFIG_FIELDS.map((field) => field.path).sort())
      .toEqual([...CARD_SETTINGS_KEYS].sort())
  })
})

describe('buildSettingsPatch', () => {
  function draft(spec: Omit<ConfigFieldDraft, 'custom'> & { custom?: boolean }): ConfigFieldDraft {
    return { custom: false, ...spec }
  }

  it('sends nothing for unchanged fields and unparsable numbers', () => {
    expect(buildSettingsPatch([
      draft({ path: 'budgets.searchTopK', kind: 'number', baseline: '6', draft: '6' }),
      draft({ path: 'budgets.readSections', kind: 'number', baseline: '2', draft: 'abc' }),
    ])).toEqual({ set: {}, unset: [] })
  })

  it('parses widths, budgets, toggles, and text into the nested set', () => {
    expect(buildSettingsPatch([
      draft({ path: 'vectorDim', kind: 'dim', baseline: '384', draft: '256' }),
      draft({ path: 'budgets.globalMemoryTokens', kind: 'number', baseline: '1500', draft: ' 2000 ' }),
      draft({ path: 'llm.enabled', kind: 'toggle', baseline: 'off', draft: 'on' }),
      draft({ path: 'llm.apiKeyEnv', kind: 'text', baseline: '', draft: ' MY_KEY ' }),
    ])).toEqual({
      set: {
        vectorDim: 256,
        budgets: { globalMemoryTokens: 2000 },
        llm: { enabled: true, apiKeyEnv: 'MY_KEY' },
      },
      unset: [],
    })
  })

  it('blanks: number fields send nothing, custom text unsets, plain text sends nothing', () => {
    expect(buildSettingsPatch([
      draft({ path: 'budgets.searchTopK', kind: 'number', baseline: '6', draft: '', custom: true }),
      draft({ path: 'model.cacheDir', kind: 'text', baseline: '/x', draft: '', custom: true }),
      draft({ path: 'llm.baseUrl', kind: 'text', baseline: 'https://x', draft: '', custom: false }),
    ])).toEqual({ set: {}, unset: ['model.cacheDir'] })
  })
})

describe('seeded rendering', () => {
  it('shows the loading hint before the GET lands and the error banner after a failed one', async () => {
    stubSettings({ get: { status: 500, body: { error: { code: '', message: 'settings route exploded' } } } })
    const fake = fakeReact()
    liveFake = fake
    const loading = renderPass(fake)
    expect(divTexts(loading)).not.toContain('Retrieval')
    expect(descendants(loading).some(
      (element) => element.props['text'] === 'Loading configuration\u2026',
    )).toBe(true)
    await flush()
    const failed = renderPass(fake)
    expect(divTexts(failed)).toContain('settings route exploded')
  })

  it('seeds controls from the settings answer and badges overridden knobs', async () => {
    const { render } = await mount({
      get: ok({
        settings: { ...SETTINGS, model: { ...SETTINGS.model, id: 'custom/embedder' } },
        overrides: { model: { id: 'custom/embedder' } },
      }),
    })
    const root = render()
    expect(inputByTitle(root, MODEL_ID_TITLE).props['value']).toBe('custom/embedder')
    expect(selectByLabel(root, 'Vector width').props['value']).toBe('384')
    expect(spanTexts(root)).toContain('custom')
    expect(divTexts(root)).toContain('Retrieval')
    expect(divTexts(root)).toContain(
      'Lossy widths trade recall for speed; changes force a full re-index.',
    )
    expect(spanTexts(root)).not.toContain('restart to apply')
    // Apply starts gated: nothing is dirty yet.
    expect(buttonByLabel(root, 'Apply changes').props['disabled']).toBe(true)
  })

  it('gates the keyword-LLM rows on the enabled toggle', async () => {
    const { render } = await mount({ get: ok() })
    expect(inputByTitle(render(), BASE_URL_TITLE).props['disabled']).toBe(true)
    setInput(selectByLabel(render(), 'Keyword LLM'), 'on')
    const root = render()
    expect(inputByTitle(root, BASE_URL_TITLE).props['disabled']).toBe(false)
    // The toggle flip alone is dirty: Apply unlocks.
    expect(buttonByLabel(root, 'Apply changes').props['disabled']).toBe(false)
  })
})

describe('apply body', () => {
  it('POSTs the dirty set plus the unset of a blanked custom field', async () => {
    const { calls, render } = await mount({
      get: ok({
        settings: { ...SETTINGS, model: { ...SETTINGS.model, cacheDir: '/custom/models' } },
        overrides: { model: { cacheDir: '/custom/models' } },
      }),
    })
    let root = render()
    setInput(inputByTitle(root, TOP_K_TITLE), '10')
    root = render()
    setInput(inputByTitle(root, CACHE_DIR_TITLE), '')
    root = render()
    click(buttonByLabel(root, 'Apply changes'))
    await flush()
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.url).toBe('/obsidian-mem/settings')
    expect(post?.body).toEqual({
      set: { budgets: { searchTopK: 10 } },
      unset: ['model.cacheDir'],
    })
  })

  it('a blank number field does not send that key', async () => {
    const { calls, render } = await mount({ get: ok() })
    let root = render()
    setInput(inputByTitle(root, TOP_K_TITLE), '')
    // A blank field is not a submittable patch: Apply stays gated.
    root = render()
    expect(buttonByLabel(root, 'Apply changes').props['disabled']).toBe(true)
    setInput(inputByTitle(root, READ_SECTIONS_TITLE), '3')
    root = render()
    click(buttonByLabel(root, 'Apply changes'))
    await flush()
    const post = calls.find((call) => call.method === 'POST')
    // The blank field is skipped entirely: the budgets object carries only
    // the one edited number.
    expect(post?.body).toEqual({ set: { budgets: { readSections: 3 } } })
  })

  it('re-seeds from the fresh view and toasts on success', async () => {
    const { render } = await mount({
      get: ok(),
      post: ok({
        settings: { ...SETTINGS, budgets: { ...SETTINGS.budgets, searchTopK: 10 } },
        overrides: { budgets: { searchTopK: 10 } },
      }),
    })
    let root = render()
    setInput(inputByTitle(root, TOP_K_TITLE), '10')
    root = render()
    click(buttonByLabel(root, 'Apply changes'))
    await flush()
    root = render()
    // The draft now equals the fresh effective value: Apply is gated again,
    // and the overridden knob shows its badge without another edit.
    expect(inputByTitle(root, TOP_K_TITLE).props['value']).toBe('10')
    expect(buttonByLabel(root, 'Apply changes').props['disabled']).toBe(true)
    expect(spanTexts(root)).toContain('custom')
    // The native Toast fallback is a role="status" div carrying the copy.
    expect(divTexts(root)).toContain('Settings applied')
  })
})

describe('reset all', () => {
  it('is a two-step confirm and DELETEs with an empty JSON body', async () => {
    const { calls, render } = await mount({
      get: ok({
        settings: { ...SETTINGS, budgets: { ...SETTINGS.budgets, searchTopK: 10 } },
        overrides: { budgets: { searchTopK: 10 } },
      }),
      del: ok(),
    })
    let root = render()
    expect(spanTexts(root)).toContain('custom')
    click(buttonByLabel(root, 'Reset all to profile settings'))
    root = render()
    // Armed, not fired: the confirm stands next to Cancel, nothing left yet.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(buttonByLabel(root, 'Confirm reset')).toBeDefined()
    expect(buttonByLabel(root, 'Cancel')).toBeDefined()
    click(buttonByLabel(root, 'Confirm reset'))
    await flush()
    const del = calls.find((call) => call.method === 'DELETE')
    expect(del?.url).toBe('/obsidian-mem/settings')
    expect(del?.body).toEqual({})
    // The fresh override-free view re-seeded: the badge is gone and the
    // searchTopK draft shows the row value again.
    root = render()
    expect(spanTexts(root)).not.toContain('custom')
    expect(inputByTitle(root, TOP_K_TITLE).props['value']).toBe('6')
  })

  it('Cancel disarms the confirm without a request', async () => {
    const { calls, render } = await mount({ get: ok() })
    let root = render()
    click(buttonByLabel(root, 'Reset all to profile settings'))
    root = render()
    click(buttonByLabel(root, 'Cancel'))
    root = render()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(buttonByLabel(root, 'Reset all to profile settings')).toBeDefined()
  })
})

describe('restartPending', () => {
  it('renders the chip on the dbPath row and the warning banner', async () => {
    const { render } = await mount({ get: ok({ restartPending: ['milvus.dbPath'] }) })
    const root = render()
    expect(spanTexts(root)).toContain('restart to apply')
    expect(divTexts(root)).toContain('Restart the host to apply: milvus.dbPath')
  })
})
