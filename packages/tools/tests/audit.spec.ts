import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { defaultVaultPath, TOOL_MEMORY_AUDIT } from '../../core/lib/index.js'
import type { AuditReport } from '../../service/lib/audit.js'
import { AUDIT_VIEWS } from '../../service/lib/audit.js'
import type { VaultEntry } from '../../service/lib/index.js'
import { AUDIT_PARAMETERS, AUDIT_TIMEOUT_MS, createAuditTool, executeAudit, firstSharedVaultPath, renderAudit } from '../src/audit.ts'
import { createFakeService, matchesOutput, renderTool, vaultEntries } from './testkit.ts'

/**
 * memory_audit tool tests (TASK-034): the {view, limit} request forwards,
 * arguments are parsed and range-checked by the tool (raw definitions get
 * no host-side validation), the mapped value validates against the
 * registered output schema the way the host enforces it, service faults
 * come back as the `failed` kind instead of throws, render keeps ISSUE
 * before INFO with the over-budget compaction list, and (TASK-009) the
 * churn and git rollups map and render, with the checkpoint view appending
 * the interpolated completion-checkpoint instructions.
 */

function reportFixture(over: Partial<AuditReport> = {}): AuditReport {
  return {
    ok: false,
    generatedAt: 1730000000000,
    view: 'full',
    limit: 50,
    issues: [
      { id: 'vault.writable', severity: 'ISSUE', detail: 'shared vault "/v" is not writable', remediation: 'make the directory writable or switch to read-only' },
      { id: 'index.live', severity: 'INFO', detail: 'milvus at 127.0.0.1:19530', remediation: 'none' },
      { id: 'budget.over', severity: 'ISSUE', detail: 'global memory injection is over budget: 2000 of 1500 tokens used, injected since the last successful dream or host restart', remediation: 'as the lighter remedy, compact the global memory only, least-read first: "/v/unread.md", "/v/a.md"; survey with memory_search, review with memory_read, merge or correct with memory_write, retire the weakest with archive: true; ask the user to approve this manual compaction and do not start until the user approves; also suggest to the user that the much heavier memory_dream is available for a more complete optimization of the whole memory store' },
    ],
    stats: {
      vaultCount: 1,
      sharedVaultCount: 1,
      noteCount: 2,
      archivedCount: 0,
      totalBytes: 4096,
      vaultUsage: [{ vault: '/v', notes: 2, bytes: 4096 }],
      oversizedNotes: ['/v/big.md'],
      hugeNotReadNotes: [],
      malformedNotes: [],
      indexer: { indexed: 5, pending: 0, errors: 0, llmErrors: 0 },
      collectionCount: 7,
      expectedChunks: 7,
      lastDreamAt: null,
      dreamingSchedules: 0,
      git: [],
    },
    rows: [
      { path: '/v/a.md', sizeBytes: 2048, mtimeMs: 1700000000000, readCount: 3, lastReadAt: '2026-11-01', archived: false, indexed: true, flaggedNotRead: false, oversized: false, churn: 0 },
      { path: '/v/unread.md', sizeBytes: 512, mtimeMs: 1700000000000, readCount: 0, lastReadAt: '', archived: false, indexed: false, flaggedNotRead: false, oversized: false, churn: 0 },
    ],
    totalRows: 2,
    budget: {
      budgetTokens: 1500,
      usedTokens: 2000,
      measured: true,
      overBudget: true,
      globalNoteCount: 2,
      globalNotePaths: ['/v/unread.md', '/v/a.md'],
      compactableGlobalNotePaths: ['/v/unread.md', '/v/a.md'],
    },
    ...over,
  }
}

function fixture(report: AuditReport | null = reportFixture(), vaults: VaultEntry[] = []) {
  const service = createFakeService({ vaults, ...(report === null ? {} : { auditReport: report }) })
  const definition = createAuditTool(service)
  return { service, definition }
}

// One dirty-adopted vault and one failed read: the two shapes the git
// rollup renders (the fixture default keeps git empty).
const gitAdopted = { vault: '/v', initialized: true, clean: false, headHash: '0123456789abcdef0123456789abcdef01234567', error: null }
const gitFailed = { vault: '/w', initialized: false, clean: null, headHash: null, error: 'fatal: not a git repository' }

describe('memory_audit execute', () => {
  it('forwards the optional view and limit to the service audit', async () => {
    const { service } = fixture()
    await executeAudit(service, {})
    expect(service.auditRequests).toEqual([{}])
    await executeAudit(service, { view: 'topStale', limit: 5 })
    expect(service.auditRequests[1]).toEqual({ view: 'topStale', limit: 5 })
    await executeAudit(service, { view: 'checkpoint' })
    expect(service.auditRequests[2]).toEqual({ view: 'checkpoint' })
    expect(service.ensureCalls).toBe(0)
  })

  it('rejects an unknown view and a non-numeric limit (host shows the throw)', async () => {
    const { service } = fixture()
    await expect(executeAudit(service, { view: 'everything' })).rejects.toThrow('view')
    await expect(executeAudit(service, { limit: 'ten' })).rejects.toThrow('limit')
    expect(service.auditRequests).toEqual([])
  })

  it('maps a full report to a value that validates against output.schema', async () => {
    const { service, definition } = fixture()
    const value = await executeAudit(service, {})
    expect(matchesOutput(definition, value)).toEqual([])
    if (value.kind !== 'audit') {
      throw new Error('expected the audit kind')
    }
    expect(value.ok).toBe(false)
    expect(value.generated_at).toBe(new Date(1730000000000).toISOString())
    expect(value.issues.map((entry) => entry.severity)).toEqual(['ISSUE', 'INFO', 'ISSUE'])
    expect(value.stats.indexer).toEqual({ indexed: 5, pending: 0, errors: 0, llm_errors: 0 })
    expect(value.rows[1]).toMatchObject({ read_count: 0, last_read_at: '', indexed: false })
    expect(value.budget.used_tokens).toBe(2000)
    expect(value.rows_total).toBe(2)
  })

  it('maps churn and the git rollup onto a value that validates against output.schema', async () => {
    const base = reportFixture()
    const { service, definition } = fixture({
      ...base,
      stats: { ...base.stats, git: [gitAdopted, gitFailed] },
      rows: base.rows.map((row, index) => ({ ...row, churn: index === 0 ? 0.5 : 0 })),
    })
    const value = await executeAudit(service, {})
    expect(matchesOutput(definition, value)).toEqual([])
    if (value.kind !== 'audit') {
      throw new Error('expected the audit kind')
    }
    expect(value.rows[0]?.churn).toBe(0.5)
    expect(value.stats.git).toEqual([
      { vault: '/v', initialized: true, clean: false, head_hash: '0123456789abcdef0123456789abcdef01234567', error: null },
      { vault: '/w', initialized: false, clean: null, head_hash: null, error: 'fatal: not a git repository' },
    ])
  })

  it('keeps a cold index honest as nulls, not zeros', async () => {
    const { service, definition } = fixture(reportFixture({
      stats: {
        ...reportFixture().stats,
        indexer: null,
        collectionCount: null,
        expectedChunks: null,
      },
    }))
    const value = await executeAudit(service, {})
    expect(matchesOutput(definition, value)).toEqual([])
    if (value.kind !== 'audit') {
      throw new Error('expected the audit kind')
    }
    expect(value.stats.indexer).toBeNull()
    expect(value.stats.collection_count).toBeNull()
    expect(value.stats.expected_chunks).toBeNull()
    expect(value.stats.last_dream_at).toBeNull()
  })

  it('returns the failed kind when the service throws', async () => {
    const { service, definition } = fixture(null)
    const value = await executeAudit(service, {})
    expect(matchesOutput(definition, value)).toEqual([])
    expect(value.kind).toBe('failed')
    if (value.kind === 'failed') {
      expect(value.message).toContain('memory_audit could not complete')
    }
  })
})

describe('memory_audit render', () => {
  it('leads with the rollup, lists issues in service order, and names the manual compaction order', async () => {
    const { service } = fixture()
    const value = await executeAudit(service, {})
    const text = renderAudit(value)
    const lines = text.split('\n')
    expect(lines[0]).toContain('found problems')
    const issueLines = lines.filter((line) => line.startsWith('- [ISSUE]') || line.startsWith('- [INFO]'))
    expect(issueLines[0]).toContain('vault.writable')
    expect(text).toContain('OVER BUDGET: as the lighter remedy, compact the global memory only')
    expect(text).toContain('ask the user to approve this manual compaction and do not start until the user approves')
    expect(text).toContain('the much heavier memory_dream is available for a more complete optimization of the whole memory store')
    expect(text).toContain('Global notes to compact, least-read first:')
    expect(text.indexOf('/v/unread.md')).toBeLessThan(text.indexOf('/v/a.md'))
    expect(text).toContain('never read')
    expect(text).toContain('not indexed')
    // Token discipline: the untouched-note, gitless store renders neither.
    expect(text).not.toContain('churn')
    expect(text).not.toContain('Git (')
  })

  it('renders churn on churned rows and one git line per rollup entry', async () => {
    const base = reportFixture()
    const { service } = fixture({
      ...base,
      stats: { ...base.stats, git: [gitAdopted, gitFailed] },
      rows: base.rows.map((row, index) => ({ ...row, churn: index === 0 ? 0.25 : 1 })),
    })
    const text = renderAudit(await executeAudit(service, {}))
    expect(text).toContain('- /v/a.md (2.0 KiB, read 2026-11-01 (3x), churn 25%)')
    expect(text).toContain('- /v/unread.md (512 B, never read, not indexed, churn 100%)')
    expect(text).toContain('Git (/v): dirty [head 0123456]')
    expect(text).toContain('Git (/w): unavailable')
  })

  it('appends the vault-interpolated completion checkpoint for the checkpoint view', async () => {
    const vaults = vaultEntries({ path: '/shared-v', mode: 'shared' })
    const { service, definition } = fixture(reportFixture({ view: 'checkpoint' }), vaults)
    const text = renderTool(definition, await executeAudit(service, { view: 'checkpoint' }))
    expect(text).toContain('# Completion Checkpoint')
    expect(text).toContain('/shared-v/.INTENTS.md with those intent(s)')
    expect(text).not.toContain('{{FIRST_SHARED_VAULT}}')
    // The note rows and every section above them match a full-view render.
    const { service: fullService } = fixture(reportFixture())
    const fullText = renderAudit(await executeAudit(fullService, {}), vaults)
      .replace('Notes (full,', 'Notes (checkpoint,')
    expect(text.startsWith(fullText)).toBe(true)
  })

  it('falls back to the default vault path in the checkpoint view with no shared vault', async () => {
    const { service, definition } = fixture(reportFixture({ view: 'checkpoint' }))
    const text = renderTool(definition, await executeAudit(service, { view: 'checkpoint' }))
    expect(text).toContain(`${defaultVaultPath(homedir())}/.INTENTS.md`)
    expect(text).not.toContain('{{FIRST_SHARED_VAULT}}')
  })

  it('renders the unmeasured budget as the tracker being inactive', async () => {
    const { service } = fixture(reportFixture({
      ok: true,
      issues: [],
      budget: { budgetTokens: 1500, usedTokens: 0, measured: false, overBudget: false, globalNoteCount: 0, globalNotePaths: [], compactableGlobalNotePaths: [] },
    }))
    const text = renderAudit(await executeAudit(service, {}))
    expect(text).toContain('no recall budget spent since the last successful dream or host restart (configured budget 1500 tokens)')
    expect(text).toContain('found no problems')
    expect(text).toContain('- none')
  })

  it('renders a protected-only over-budget store as compaction that cannot help', async () => {
    const { service } = fixture(reportFixture({
      // Keep the finding echo honest for the scenario: a protected-only
      // store gets the compaction-cannot-help remediation naming the
      // protected file, not the ordinary compactable-list one.
      issues: [
        ...reportFixture().issues.slice(0, 2),
        { id: 'budget.over', severity: 'ISSUE', detail: 'global memory injection is over budget: 2000 of 1500 tokens used, injected since the last successful dream or host restart', remediation: 'compaction cannot help: every live global note is a vault global file the dreaming pass never compacts; with the user\'s approval, manually tighten "/v/GLOBAL.md" to reclaim budget' },
      ],
      budget: {
        budgetTokens: 1500,
        usedTokens: 2000,
        measured: true,
        overBudget: true,
        globalNoteCount: 1,
        globalNotePaths: ['/v/GLOBAL.md'],
        compactableGlobalNotePaths: [],
      },
    }))
    const text = renderAudit(await executeAudit(service, {}))
    expect(text).toContain('OVER BUDGET: compaction cannot help')
    expect(text).toContain('with the user\'s approval, tighten these files by hand to shrink every session')
    expect(text).toContain('- /v/GLOBAL.md')
    const overLine = text.split('\n').find((line) => line.startsWith('OVER BUDGET:')) ?? ''
    expect(overLine).not.toContain('memory_dream')
  })

  it('renders the failed kind as its message', () => {
    expect(renderAudit({ kind: 'failed', message: 'boom' })).toBe('boom')
  })
})

describe('memory_audit definition', () => {
  it('carries the fixed name, timeout budget, and a search-style presentCall', () => {
    const { definition } = fixture()
    expect(definition.name).toBe(TOOL_MEMORY_AUDIT)
    expect(definition.timeoutMs).toBe(AUDIT_TIMEOUT_MS)
    expect(definition.timeoutMs).toBe(30_000)
    const card = definition.presentCall?.({ view: 'oldestUnread' })
    expect(card).toMatchObject({ card: 'generic', kind: 'read', title: `${TOOL_MEMORY_AUDIT} oldestUnread` })
  })

  it('flows the view enum from AUDIT_VIEWS, checkpoint included', () => {
    expect(AUDIT_VIEWS).toContain('checkpoint')
    expect(AUDIT_PARAMETERS.properties?.view?.enum).toEqual([...AUDIT_VIEWS])
  })
})

describe('firstSharedVaultPath', () => {
  it('picks the first shared vault and falls back to the default vault path', () => {
    expect(firstSharedVaultPath([
      { path: '/ro', mode: 'read-only' },
      { path: '/s1', mode: 'shared' },
      { path: '/s2', mode: 'shared' },
    ])).toBe('/s1')
    expect(firstSharedVaultPath([], '/home/u')).toBe(defaultVaultPath('/home/u'))
  })
})
