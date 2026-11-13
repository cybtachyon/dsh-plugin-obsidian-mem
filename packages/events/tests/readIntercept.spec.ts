import { afterEach, describe, expect, it } from 'vitest'

import type { VaultEntry } from '../../service/lib/index.js'
import { GLOBAL_MEMORY_FILE_DEFAULT } from '../../core/lib/index.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import {
  dirSignalsOf,
  importSnippetFrom,
  mountLifecycle,
} from '../src/index.ts'
import { sourceKeyFor } from '../src/sessions.ts'
import type { LiveAgent, ToolExecutionMirror, ToolResultMirror } from '../src/host.ts'
import {
  fakeAgent,
  fakeEventsCtx,
  fakeMemory,
  memoryResult,
  tempDbPath,
  toolResult,
} from './testkit.ts'

/**
 * Read-intercept specs (TASK-042): the tools/result filter matrix (tool
 * name, agent presence, errors, vault-contained files, already-injected
 * sources, offline index with warn-once), the session throttle, cap, and
 * directory skip, the per-turn path dedupe, extraction fixtures (import
 * snippet, directory signals), request budget wiring, and the injected
 * envelope order (provisioning notice, then locality + wrapped sections).
 */

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const VAULT_PATH = '/home/test/vault'
const THROTTLE_MS = 15_000

interface HarnessOptions {
  exactResults?: ReturnType<typeof memoryResult>[]
  exactError?: Error
}

function readHarness(options: HarnessOptions = {}) {
  const tmp = tempDbPath()
  cleanups.push(tmp.cleanup)
  const memory = fakeMemory({
    dbPath: tmp.dir,
    vaults: [{
      path: VAULT_PATH,
      mode: 'read-only',
      globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
      source: 'settings',
    }] satisfies VaultEntry[],
    notice: 'Obsidian Mem: using the default memory vault at /home/test/.dsh/obsidian-mem',
    ...(options.exactResults === undefined ? {} : { exactResults: options.exactResults }),
    ...(options.exactError === undefined ? {} : { exactError: options.exactError }),
  })
  const ctx = fakeEventsCtx(memory)
  let clock = 5_000_000_000_000
  let messageCount = 0
  const registry = mountLifecycle(ctx.scope, {
    now: () => clock,
    newMessageId: () => `msg-${messageCount++}`,
  })
  const agent = fakeAgent({ id: 'agent-1', cwd: '/work/project' })
  ctx.emit('agent/created', agent.asCreated())
  const readResult = toolResult(false, [
    '1\timport React from "react"',
    '2\timport { helper } from "./helper"',
    '3\tconst App = () => null',
  ].join('\n'))

  /**
   * Emit one tools/result for a harness Read. `agent: false` drops the
   * executing agent from the payload (exactOptionalPropertyTypes-safe).
   */
  function read(call: { name?: string, arguments?: unknown, agent?: LiveAgent | false } = {}, result: ToolResultMirror = readResult): void {
    const exec: ToolExecutionMirror = {
      name: call.name ?? 'read',
      arguments: call.arguments ?? { file_path: '/work/project/src/App.tsx' },
      ...(call.agent === false ? {} : { agent }),
    }
    ctx.emit('tools/result', exec, result)
  }

  /** Move the shared registry clock forward. */
  function advance(ms: number): void {
    clock += ms
  }

  return { agent, advance, ctx, memory, read, registry }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const sectionA = memoryResult({
  chunk_id: 1,
  source_path: 'react.md',
  chunk_text: 'components stay pure here',
  updated_at: 1_700_000_000_555,
})

const sectionB = memoryResult({
  chunk_id: 2,
  source_path: 'vite.md',
  chunk_text: 'builds go through vite here',
  updated_at: 1_700_000_000_999,
})

describe('tools/result filter matrix', () => {
  it('ignores other tools, memory_read included (a different name, never read)', async () => {
    const { memory, read } = readHarness({ exactResults: [sectionA] })
    read({ name: 'write' })
    read({ name: 'memory_read' })
    await settled()
    expect(memory.exactRequests).toHaveLength(0)
  })

  it('ignores errored results, missing agents, and missing file paths', async () => {
    const { memory, read } = readHarness({ exactResults: [sectionA] })
    read({}, toolResult(true, 'ENOENT'))
    read({ agent: false })
    read({ arguments: {} })
    await settled()
    expect(memory.exactRequests).toHaveLength(0)
  })

  it('never fires for files inside a registered vault (the loop guard)', async () => {
    const { agent, memory, read } = readHarness({ exactResults: [sectionA] })
    read({ arguments: { file_path: `${VAULT_PATH}/react.md` } })
    await settled()
    expect(memory.exactRequests).toHaveLength(0)
    expect(agent.injected).toHaveLength(0)
  })

  it('skips sources already injected this session (query runs, envelope does not)', async () => {
    const { agent, memory, read, registry } = readHarness({ exactResults: [sectionA] })
    registry.markInjected('agent-1', sourceKeyFor(sectionA), String(sectionA.updated_at))
    read()
    await settled()
    expect(memory.exactRequests).toHaveLength(1)
    expect(agent.injected).toHaveLength(0)
  })

  it('offline index: silent skip, warn once across repeat reads', async () => {
    const { agent, ctx, memory, read } = readHarness({
      exactError: new IndexOfflineError('memory index is offline'),
    })
    read({ arguments: { file_path: '/work/project/src/A.ts' } })
    await settled()
    read({ arguments: { file_path: '/work/project/src/B.ts' } })
    await settled()
    expect(agent.injected).toHaveLength(0)
    expect(ctx.warnings.filter((w) => w.includes('index offline'))).toHaveLength(1)
    expect(memory.exactRequests).toHaveLength(2)
  })

  it('dedupes a path per turn; a new turn lets it through again', async () => {
    const { memory, read, registry } = readHarness({ exactError: new Error('search down') })
    read()
    await settled()
    read()
    await settled()
    expect(memory.exactRequests).toHaveLength(1)
    registry.noteTurn('agent-1', 2)
    read()
    await settled()
    expect(memory.exactRequests).toHaveLength(2)
  })

  it('throttles a second injection inside the 15 s window', async () => {
    const { memory, read } = readHarness({ exactResults: [sectionA] })
    read({ arguments: { file_path: '/work/project/src/A.tsx' } })
    await settled()
    read({ arguments: { file_path: '/work/project/docs/B.md' } })
    await settled()
    expect(memory.exactRequests).toHaveLength(1)
  })

  it('skips a directory an injection already covered, once the window passes', async () => {
    const { advance, memory, read } = readHarness({ exactResults: [sectionA] })
    read({ arguments: { file_path: '/work/project/src/A.tsx' } })
    await settled()
    advance(THROTTLE_MS + 1)
    read({ arguments: { file_path: '/work/project/src/Other.tsx' } })
    await settled()
    expect(memory.exactRequests).toHaveLength(1)
  })

  it('enforces the six-injection session cap independent of the think budget', async () => {
    const { advance, memory, read, registry } = readHarness({ exactResults: [sectionA] })
    for (let i = 0; i < 6; i += 1) {
      registry.noteReadInjection('agent-1', `/work/other-${i}`)
      advance(THROTTLE_MS + 1)
    }
    read({ arguments: { file_path: '/work/project/src/Fresh.tsx' } })
    await settled()
    expect(memory.exactRequests).toHaveLength(0)
  })

  it('resolves relative paths against the session workspace cwd', async () => {
    const { memory, read } = readHarness()
    read({ arguments: { file_path: 'src/App.tsx' } })
    await settled()
    expect(memory.exactRequests[0]!.filePath).toBe('/work/project/src/App.tsx')
  })
})

describe('request wiring and injected envelope', () => {
  it('asks for readSections x readSectionTokens with ext, signals, snippet', async () => {
    const { memory, read } = readHarness({ exactResults: [sectionA] })
    read()
    await settled()
    const request = memory.exactRequests[0]!
    expect(request.filePath).toBe('/work/project/src/App.tsx')
    expect(request.ext).toBe('.tsx')
    expect(request.k).toBe(2)
    expect(request.sectionTokens).toBe(350)
    expect(request.dirSignals).toEqual(['work', 'project', 'src'])
    expect(request.snippet).toContain('import React from "react"')
    expect(request.snippet).toContain('import { helper } from "./helper"')
    expect(request.snippet).not.toContain('const App')
  })

  it('injects the notice first, then locality + wrapped sections; marks all', async () => {
    const { agent, read, registry } = readHarness({ exactResults: [sectionA] })
    read()
    await settled()
    expect(agent.injected).toHaveLength(2)
    expect(agent.injected[0]!.content[0]!.text).toContain('default memory vault')
    const blocks = agent.injected[1]!.content
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toContain('your read of /work/project/src/App.tsx')
    expect(blocks[1]!.text).toBe(
      '<recalled_memory source="react.md">\ncomponents stay pure here\n</recalled_memory>',
    )
    expect(registry.injectedSources('agent-1').has(sourceKeyFor(sectionA))).toBe(true)
    expect(registry.readDirCovered('agent-1', '/work/project/src')).toBe(true)
    expect(registry.recallTokensUsed('agent-1')).toBeGreaterThan(0)
  })

  it('injects no bare notice when every section was already injected', async () => {
    const { agent, registry, read } = readHarness({ exactResults: [sectionA] })
    registry.markInjected('agent-1', sourceKeyFor(sectionA), String(sectionA.updated_at))
    read()
    await settled()
    expect(agent.injected).toHaveLength(0)
  })

  it('drops sections the session wrote itself from the envelope (TASK-003)', async () => {
    const { agent, registry, read } = readHarness({ exactResults: [sectionA, sectionB] })
    // The registry ledger path stands in here: writeLedger.spec.ts and the
    // think spec cover the tools/result observation that fills it.
    registry.noteWrittenSource('agent-1', sourceKeyFor(sectionA))
    read()
    await settled()
    expect(agent.injected).toHaveLength(2) // the notice, then one recall
    const blocks = agent.injected[1]!.content
    expect(blocks).toHaveLength(2) // locality + sectionB only
    expect(blocks[0]!.text).toContain('your read of /work/project/src/App.tsx')
    expect(blocks[1]!.text).toBe(
      '<recalled_memory source="vite.md">\nbuilds go through vite here\n</recalled_memory>',
    )
  })

  it('an offline skip keeps the notice pending; the next injection delivers it once', async () => {
    const { agent, advance, memory, read } = readHarness({
      exactError: new IndexOfflineError('memory index is offline'),
    })
    read({ arguments: { file_path: '/work/project/src/A.tsx' } })
    await settled()
    expect(agent.injected).toHaveLength(0)
    // The index comes back; the notice rode the registry's pending slot
    // through the offline skip and now reads exactly once.
    let answer = [sectionA]
    memory.searchExactSections = async (request) => {
      memory.exactRequests.push(request)
      return answer
    }
    read({ arguments: { file_path: '/work/project/docs/B.md' } })
    await settled()
    expect(agent.injected.map((message) => message.content[0]!.text)).toEqual([
      expect.stringContaining('default memory vault'),
      expect.stringContaining('your read of /work/project/docs/B.md'),
    ])
    // Exactly once: a later successful injection adds recall, never a repeat.
    answer = [sectionB]
    advance(THROTTLE_MS + 1)
    read({ arguments: { file_path: '/work/tree2/C.md' } })
    await settled()
    const noticeMessages = agent.injected.filter((message) =>
      message.content.some((block) => block.text !== undefined && block.text.includes('default memory vault')),
    )
    expect(noticeMessages).toHaveLength(1)
    expect(agent.injected).toHaveLength(3)
  })

  it('fires again after the window from a different directory', async () => {
    const { advance, memory, read } = readHarness({ exactResults: [sectionA] })
    read({ arguments: { file_path: '/work/project/src/A.tsx' } })
    await settled()
    advance(THROTTLE_MS + 1)
    read({ arguments: { file_path: '/work/project/docs/B.md' } })
    await settled()
    expect(memory.exactRequests).toHaveLength(2)
  })
})

describe('extraction fixtures', () => {
  it('importSnippetFrom strips line numbers, filters, and caps', () => {
    const numbered = Array.from({ length: 30 }, (_, i) => `${i + 1}\timport x${i} from "m"`).join('\n')
    const snippet = importSnippetFrom([{ type: 'text', text: numbered }])
    expect(snippet.split('\n')).toHaveLength(12)
    expect(snippet.split('\n')[0]).toBe('import x0 from "m"')
    expect(importSnippetFrom([{ type: 'image', text: 'import nope' }])).toBe('')
    expect(importSnippetFrom([{ type: 'text', text: 'plain\nlines only' }])).toBe('')
  })

  it('dirSignalsOf keeps identifier-ish segments, deepest last, capped', () => {
    expect(dirSignalsOf('/work/project/src/App.tsx')).toEqual(['work', 'project', 'src'])
    expect(dirSignalsOf('/home/u/.dsh/deep/dir/notes/a.md')).toEqual(
      ['home', 'u', 'deep', 'dir', 'notes'],
    )
    expect(dirSignalsOf('relative/path.md')).toEqual(['relative'])
  })
})
