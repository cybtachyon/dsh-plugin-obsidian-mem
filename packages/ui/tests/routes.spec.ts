/**
 * Route behavior specs for the `/obsidian-mem/*` API: every endpoint's happy
 * answer, the service-throw envelope and status, the shared HTTP discipline
 * (405 + allow, 415 / 413 / 400 bodies, trust fence, no-store, no stack on
 * the wire), the one-record-per-path mount (simulated host duplicate throw),
 * the schedule trio's gateway-absent answers, and the ROUTES contract.
 * @module dsh-plugin-obsidian-mem/ui/tests/routes
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import plugin, { buildRoutes, ROUTES } from '../src/index.ts'
import { GLOBAL_MEMORY_FILE_DEFAULT } from '../../core/lib/index.js'
import type { CardSettingsView } from '../../service/lib/index.js'
import { DreamBlockedError, DreamBusyError } from '../../service/lib/dream.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import {
  baseStatus,
  dreamSummary,
  envelopeOf,
  FakeCordisContext,
  makeRouteServiceWithCalls,
  makeScheduleGateway,
  searchRow,
  send,
  sendRaw,
} from './testkit.ts'

/** Mount a web-profile context with the routes registered, ready to drive. */
function harness(
  options: Parameters<typeof makeRouteServiceWithCalls>[0] & {
    schedule?: ReturnType<typeof makeScheduleGateway>['gateway'] | null
    connection?: { requestRejection: () => number | undefined }
  } = {},
): FakeCordisContext {
  const { schedule, connection, ...serviceOptions } = options
  const context = new FakeCordisContext({
    obsidianMem: makeRouteServiceWithCalls(serviceOptions).service,
    schedule: schedule === null ? undefined : schedule,
    connection,
  })
  plugin.apply(context as unknown as Context)
  return context
}

/** Mount plus the seam call recorder. */
function harnessWithCalls(
  options: Parameters<typeof makeRouteServiceWithCalls>[0] = {},
): {
  context: FakeCordisContext
  calls: ReturnType<typeof makeRouteServiceWithCalls>['calls']
  logs: FakeCordisContext['loggerService']
} {
  const { service, calls } = makeRouteServiceWithCalls(options)
  const context = new FakeCordisContext({ obsidianMem: service })
  plugin.apply(context as unknown as Context)
  return { context, calls, logs: context.loggerService }
}

describe('route mount', () => {
  it('registers exactly one webServer record per contract path', () => {
    const context = harness()
    const paths = context.webServer.records.map((record) => record.path)
    expect(paths).toHaveLength(new Set(paths).size)
    expect(new Set(paths)).toEqual(new Set([
      '/obsidian-mem/status',
      '/obsidian-mem/vaults',
      '/obsidian-mem/settings',
      '/obsidian-mem/audit',
      '/obsidian-mem/dream/plan',
      '/obsidian-mem/dream/run',
      '/obsidian-mem/dream/state',
      '/obsidian-mem/dreaming/schedules',
      '/obsidian-mem/search',
    ]))
    for (const record of context.webServer.records) {
      expect(record.kind).toBe('exact')
    }
  })

  it('the fake table reproduces the host duplicate (kind, path) throw', () => {
    const context = harness()
    const record = context.webServer.records[0]!
    expect(() => context.webServer.register(record)).toThrow('duplicate route')
  })

  it('unregisters every record when the effect disposer runs', () => {
    const context = harness()
    expect(context.webServer.records.length).toBeGreaterThan(0)
    context.disposeAll()
    expect(context.webServer.records).toEqual([])
  })

  it('a contract endpoint without a handler fails the build, not the boot table', () => {
    const context = harness()
    const routes = buildRoutes({
      ctx: context as unknown as Context,
      service: makeRouteServiceWithCalls().service,
      log: context.loggerService.logger(),
    })
    expect(routes.map((route) => route.path)).toEqual([...new Set(ROUTES.map((route) => route.path))])
  })
})

describe('shared HTTP discipline', () => {
  it('answers 405 with the declared methods as allow', async () => {
    const context = harness()
    const response = await send(context, 'PUT', '/obsidian-mem/status')
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('GET')
    const schedules = await send(context, 'PATCH', '/obsidian-mem/dreaming/schedules')
    expect(schedules.status).toBe(405)
    expect(schedules.headers['allow']).toBe('GET, POST, DELETE')
  })

  it('inherited Object members never read as handlers', async () => {
    const context = harness()
    const response = await send(context, 'constructor', '/obsidian-mem/status')
    expect(response.status).toBe(405)
  })

  it('answers every JSON body with cache-control no-store', async () => {
    const context = harness()
    for (const url of ['/obsidian-mem/status', '/obsidian-mem/search?q=x']) {
      const response = await send(context, 'GET', url)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['content-type']).toContain('application/json')
    }
    const bad = await send(context, 'GET', '/obsidian-mem/search')
    expect(bad.status).toBe(400)
    expect(bad.headers['cache-control']).toBe('no-store')
  })

  it('rejects an untrusted request before the handler runs', async () => {
    const context = harness({ connection: { requestRejection: () => 403 } })
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect(response.status).toBe(403)
    expect(response.text).toBe('')
  })

  it('proceeds fence-less when the connection key is not injectable', async () => {
    // The cordis proxy throws on undeclared ctx reads; the fence must
    // degrade to absent, not answer 500 (found live after install).
    const context = new FakeCordisContext({ obsidianMem: makeRouteServiceWithCalls({}).service })
    Object.defineProperty(context, 'connection', {
      get() {
        throw new TypeError('cannot get property "connection" without inject')
      },
    })
    plugin.apply(context as unknown as Context)
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect(response.status).toBe(200)
  })

  it('answers non-JSON bodies with 415 and malformed JSON with 400', async () => {
    const context = harness()
    const wrongType = await sendRaw(context, 'POST', '/obsidian-mem/vaults', {
      chunks: [Buffer.from('path=/x')],
      contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(415)
    expect(envelopeOf(wrongType.json).error.code).toBe('unsupported_media_type')
    const malformed = await sendRaw(context, 'POST', '/obsidian-mem/vaults', {
      chunks: [Buffer.from('{not json')],
    })
    expect(malformed.status).toBe(400)
    expect(envelopeOf(malformed.json).error.code).toBe('invalid_json_body')
  })

  it('destroys a body past the 64 KiB ceiling and answers 413', async () => {
    const context = harness()
    const big = Buffer.alloc(65 * 1024, 0x61)
    const response = await sendRaw(context, 'POST', '/obsidian-mem/vaults', {
      chunks: [big, big],
    })
    expect(response.status).toBe(413)
    expect(envelopeOf(response.json).error.code).toBe('payload_too_large')
  })

  it('maps unexpected failures to the internal_error envelope without leaking stacks', async () => {
    const failure = new Error('status exploded')
    failure.stack = 'status exploded\n    at ObsidianMemService.status (/lib/service.js:12:3)'
    const { context, logs } = harnessWithCalls({
      status: () => {
        throw failure
      },
    })
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect(response.status).toBe(500)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('internal_error')
    // The message reaches the card (it is actionable); the stack never does.
    expect(body.error.message).toBe('status exploded')
    expect(response.text).not.toContain('/lib/service.js')
    expect(logs.warns.some((line) => line.includes('status exploded'))).toBe(true)
  })
})

describe('GET /obsidian-mem/status', () => {
  it('answers the seam status with the dream, indexer, and noticeActive fields', async () => {
    const context = harness()
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect(response.status).toBe(200)
    const body = response.json as Record<string, never> & {
      noticeActive: boolean
      state: string
      dream: { state: string, lastDreamAt: number }
      indexer: { indexed: number }
      vaults: { path: string, mode: string, source: string, globalFile: string }[]
    }
    expect(body.noticeActive).toBe(false)
    expect(body.state).toBe('ready')
    expect(body.dream.state).toBe('idle')
    expect(body.indexer.indexed).toBe(12)
    expect(body.vaults).toHaveLength(1)
    // The status echo carries the resolved globalFile on every vault row.
    expect(body.vaults[0]!.globalFile).toBe(GLOBAL_MEMORY_FILE_DEFAULT)
  })

  it('flips noticeActive while the default-vault notice is live', async () => {
    const context = harness({
      status: () => baseStatus({ notice: 'Memory notes now live in /home/u/.dsh/obsidian-mem.' }),
    })
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect((response.json as { noticeActive: boolean }).noticeActive).toBe(true)
  })

  it('answers the envelope when the seam throws', async () => {
    const context = harness({ status: () => { throw new Error('status broke') } })
    const response = await send(context, 'GET', '/obsidian-mem/status')
    expect(response.status).toBe(500)
    expect(envelopeOf(response.json).error.message).toBe('status broke')
  })
})

describe('/obsidian-mem/vaults', () => {
  it('GET lists the registry', async () => {
    const context = harness()
    const response = await send(context, 'GET', '/obsidian-mem/vaults')
    expect(response.status).toBe(200)
    expect((response.json as { vaults: unknown[] }).vaults).toHaveLength(0)
  })

  it('GET echoes globalFile on every registry row', async () => {
    const context = harness({
      vaults: [{
        path: '/vaults/work', mode: 'shared', globalFile: 'MEMORY.md', source: 'card',
      }],
    })
    const response = await send(context, 'GET', '/obsidian-mem/vaults')
    expect(response.status).toBe(200)
    expect((response.json as { vaults: unknown[] }).vaults).toEqual([{
      path: '/vaults/work', mode: 'shared', globalFile: 'MEMORY.md', source: 'card',
    }])
  })

  it('POST registers and answers 201 with the new entry', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'POST', '/obsidian-mem/vaults', {
      path: '/vaults/work', mode: 'read-only',
    })
    expect(response.status).toBe(201)
    expect((response.json as { vault: { path: string } }).vault.path).toBe('/vault/added')
    expect(calls.addVault).toEqual([{ path: '/vaults/work', mode: 'read-only' }])
  })

  it('POST defaults the mode by omitting it for the service', async () => {
    const { context, calls } = harnessWithCalls()
    await send(context, 'POST', '/obsidian-mem/vaults', { path: '/vaults/plain' })
    expect(calls.addVault).toEqual([{ path: '/vaults/plain' }])
  })

  it('POST forwards a trimmed globalFile and echoes it in the 201 vault', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'POST', '/obsidian-mem/vaults', {
      path: '/vaults/work', globalFile: ' notes/global.md ',
    })
    expect(response.status).toBe(201)
    expect(calls.addVault).toEqual([{ path: '/vaults/work', globalFile: 'notes/global.md' }])
    expect((response.json as { vault: { globalFile: string } }).vault.globalFile).toBe('notes/global.md')
  })

  it('POST answers the service GLOBAL.md default when globalFile is omitted', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'POST', '/obsidian-mem/vaults', { path: '/vaults/plain' })
    expect(calls.addVault).toEqual([{ path: '/vaults/plain' }])
    expect((response.json as { vault: { globalFile: string } }).vault.globalFile).toBe(GLOBAL_MEMORY_FILE_DEFAULT)
  })

  it('POST rejects an empty or non-string globalFile before the service', async () => {
    const { context, calls } = harnessWithCalls()
    const blank = await send(context, 'POST', '/obsidian-mem/vaults', { path: '/x', globalFile: '   ' })
    expect(blank.status).toBe(400)
    expect(envelopeOf(blank.json).error.code).toBe('vault_invalid')
    const wrongType = await send(context, 'POST', '/obsidian-mem/vaults', { path: '/x', globalFile: 7 })
    expect(wrongType.status).toBe(400)
    expect(envelopeOf(wrongType.json).error.code).toBe('vault_invalid')
    expect(calls.addVault).toEqual([])
  })

  it('POST maps a service globalFile shape refusal to 400 vault_invalid verbatim', async () => {
    const context = harness({
      addVaultError: new Error(
        'obsidian-mem addVault: globalFile must be vault-root-relative, not absolute, got "/etc/GLOBAL.md"',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/vaults', {
      path: '/x', globalFile: '/etc/GLOBAL.md',
    })
    expect(response.status).toBe(400)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('vault_invalid')
    expect(body.error.message).toContain('vault-root-relative')
  })

  it('POST validates path and mode before the service', async () => {
    const { context, calls } = harnessWithCalls()
    const missing = await send(context, 'POST', '/obsidian-mem/vaults', {})
    expect(missing.status).toBe(400)
    expect(envelopeOf(missing.json).error.code).toBe('vault_invalid')
    const badMode = await send(context, 'POST', '/obsidian-mem/vaults', {
      path: '/x', mode: 'ReadWrite',
    })
    expect(badMode.status).toBe(400)
    expect(envelopeOf(badMode.json).error.code).toBe('vault_invalid')
    expect(calls.addVault).toEqual([])
  })

  it('POST maps a duplicate refusal to 409 vault_conflict with the service message', async () => {
    const context = harness({
      addVaultError: new Error(
        'obsidian-mem addVault: /home/u/.dsh/obsidian-mem is already registered as the same mode by lazy provisioning (it is the default memory vault)',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/vaults', { path: '~/.dsh/obsidian-mem' })
    expect(response.status).toBe(409)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('vault_conflict')
    expect(body.error.message).toContain('already registered')
  })

  it('POST maps an unusable read-only path to 400 vault_invalid', async () => {
    const context = harness({
      addVaultError: new Error(
        'obsidian-mem addVault: /missing does not exist; read-only mode indexes an existing vault, it does not create one',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/vaults', { path: '/missing', mode: 'read-only' })
    expect(response.status).toBe(400)
    expect(envelopeOf(response.json).error.code).toBe('vault_invalid')
  })

  it('DELETE removes and answers the echo', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'DELETE', '/obsidian-mem/vaults', { path: '/vaults/work' })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ removed: true, path: '/vaults/work' })
    expect(calls.removeVault).toEqual(['/vaults/work'])
  })

  it('DELETE surfaces settings and default protection as 409 vault_protected', async () => {
    const settings = harness({
      removeVaultError: new Error(
        'obsidian-mem removeVault: /vaults/config is managed by the obsidian-mem-service row config.vaults; remove it there (settings), not from the card',
      ),
    })
    const settingsAnswer = await send(settings, 'DELETE', '/obsidian-mem/vaults', { path: '/vaults/config' })
    expect(settingsAnswer.status).toBe(409)
    expect(envelopeOf(settingsAnswer.json).error.code).toBe('vault_protected')

    const autoProvisioned = harness({
      removeVaultError: new Error(
        'obsidian-mem removeVault: /home/u/.dsh/obsidian-mem is the auto-provisioned default vault; register a shared vault (card or config.vaults) to take over, then restart',
      ),
    })
    const autoAnswer = await send(autoProvisioned, 'DELETE', '/obsidian-mem/vaults', { path: '/home/u/.dsh/obsidian-mem' })
    expect(autoAnswer.status).toBe(409)
    expect(envelopeOf(autoAnswer.json).error.code).toBe('vault_protected')
  })

  it('DELETE maps an unknown vault to 404 vault_not_found', async () => {
    const context = harness({
      removeVaultError: new Error('obsidian-mem removeVault: /nope is not a registered vault'),
    })
    const response = await send(context, 'DELETE', '/obsidian-mem/vaults', { path: '/nope' })
    expect(response.status).toBe(404)
    expect(envelopeOf(response.json).error.code).toBe('vault_not_found')
  })
})

describe('/obsidian-mem/settings', () => {
  /** Narrow cast for the settings view answers. */
  type SettingsAnswer = Pick<CardSettingsView, 'settings' | 'overrides' | 'restartPending'>

  it('GET answers the merged settings, the overrides, and restartPending', async () => {
    const context = harness({
      cardSettingsOverrides: { budgets: { searchTopK: 9 } },
      cardSettingsRestartPending: ['milvus.dbPath'],
    })
    const response = await send(context, 'GET', '/obsidian-mem/settings')
    expect(response.status).toBe(200)
    const body = response.json as SettingsAnswer
    expect(body.settings.budgets.searchTopK).toBe(9)
    expect(body.settings.budgets.readSections).toBe(4)
    expect(body.overrides).toEqual({ budgets: { searchTopK: 9 } })
    expect(body.restartPending).toEqual(['milvus.dbPath'])
  })

  it('POST applies a patch, answers the fresh view, and is seen by the next GET', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'POST', '/obsidian-mem/settings', {
      set: { budgets: { searchTopK: 9 } },
    })
    expect(response.status).toBe(200)
    expect((response.json as SettingsAnswer).settings.budgets.searchTopK).toBe(9)
    expect(calls.updateCardSettings).toEqual([{ set: { budgets: { searchTopK: 9 } } }])
    const after = await send(context, 'GET', '/obsidian-mem/settings')
    expect((after.json as SettingsAnswer).overrides).toEqual({ budgets: { searchTopK: 9 } })
  })

  it('POST carries unset alongside set and only the named leaf falls back', async () => {
    const { context, calls } = harnessWithCalls({
      cardSettingsOverrides: { budgets: { searchTopK: 9 }, vectorDim: 256 },
    })
    const response = await send(context, 'POST', '/obsidian-mem/settings', {
      set: { llm: { enabled: true } },
      unset: ['budgets.searchTopK'],
    })
    expect(response.status).toBe(200)
    const body = response.json as SettingsAnswer
    expect(body.settings.budgets.searchTopK).toBe(6)
    expect(body.settings.vectorDim).toBe(256)
    expect(body.settings.llm.enabled).toBe(true)
    expect(body.overrides).toEqual({ vectorDim: 256, llm: { enabled: true } })
    expect(calls.updateCardSettings).toEqual([{
      set: { llm: { enabled: true } },
      unset: ['budgets.searchTopK'],
    }])
  })

  it('POST checks the wire shape before the service', async () => {
    const { context, calls } = harnessWithCalls()
    const cases: Record<string, unknown>[] = [
      {}, // no set
      { set: 'vectorDim' }, // not an object
      { set: null }, // not an object
      { set: ['vectorDim'] }, // not an object
      { set: {}, unset: 'vectorDim' }, // not an array
      { set: {}, unset: [7] }, // not a string array
    ]
    for (const body of cases) {
      const response = await send(context, 'POST', '/obsidian-mem/settings', body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(envelopeOf(response.json).error.code).toBe('settings_invalid')
    }
    expect(calls.updateCardSettings).toEqual([])
  })

  it('POST maps a service whitelist refusal to 400 settings_invalid verbatim', async () => {
    const context = harness({
      updateCardSettingsError: new Error(
        'obsidian-mem card settings rejected: not card-editable: milvus.mode, budgets',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/settings', {
      set: { milvus: { mode: 'address' } },
    })
    expect(response.status).toBe(400)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('settings_invalid')
    expect(body.error.message).toContain('not card-editable: milvus.mode, budgets')
  })

  it('POST maps a schema refusal the same way (the service names the leaf)', async () => {
    const context = harness({
      updateCardSettingsError: new Error(
        'obsidian-mem card settings rejected: vectorDim must be an integer >= 8, got 999',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/settings', { set: { vectorDim: 999 } })
    expect(response.status).toBe(400)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('settings_invalid')
    expect(body.error.message).toContain('vectorDim')
  })

  it('POST maps an apply still in flight to 409 settings_busy', async () => {
    const context = harness({
      updateCardSettingsError: new Error(
        'obsidian-mem card settings rejected: another apply is still in flight; retry once it answers',
      ),
    })
    const response = await send(context, 'POST', '/obsidian-mem/settings', { set: { vectorDim: 256 } })
    expect(response.status).toBe(409)
    expect(envelopeOf(response.json).error.code).toBe('settings_busy')
  })

  it('DELETE clears every override and answers the row-valued view', async () => {
    const { context, calls } = harnessWithCalls({
      cardSettingsOverrides: { budgets: { searchTopK: 9 }, vectorDim: 256 },
    })
    const response = await send(context, 'DELETE', '/obsidian-mem/settings', {})
    expect(response.status).toBe(200)
    const body = response.json as SettingsAnswer
    expect(body.settings.budgets.searchTopK).toBe(6)
    expect(body.settings.vectorDim).toBe(384)
    expect(body.overrides).toEqual({})
    expect(calls.resetCardSettings).toBe(1)
  })

  it('DELETE maps an apply still in flight to 409 settings_busy', async () => {
    const context = harness({
      resetCardSettingsError: new Error(
        'obsidian-mem card settings rejected: another apply is still in flight; retry once it answers',
      ),
    })
    const response = await send(context, 'DELETE', '/obsidian-mem/settings', {})
    expect(response.status).toBe(409)
    expect(envelopeOf(response.json).error.code).toBe('settings_busy')
  })

  it('POST shares the body discipline (415 on the media type, 400 on malformed JSON)', async () => {
    const context = harness()
    const wrongType = await sendRaw(context, 'POST', '/obsidian-mem/settings', {
      chunks: [Buffer.from('set=1')],
      contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(415)
    expect(envelopeOf(wrongType.json).error.code).toBe('unsupported_media_type')
    const malformed = await sendRaw(context, 'POST', '/obsidian-mem/settings', {
      chunks: [Buffer.from('{"set":')],
    })
    expect(malformed.status).toBe(400)
    expect(envelopeOf(malformed.json).error.code).toBe('invalid_json_body')
  })

  it('answers 405 with the declared methods as allow', async () => {
    const context = harness()
    const response = await send(context, 'PUT', '/obsidian-mem/settings')
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('GET, POST, DELETE')
  })
})

describe('GET /obsidian-mem/audit', () => {
  it('passes view and limit through to the service and answers the report', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'GET', '/obsidian-mem/audit?view=topStale&limit=10')
    expect(response.status).toBe(200)
    expect((response.json as { report: { view: string } }).report.view).toBe('topStale')
    expect(calls.audit).toEqual([{ view: 'topStale', limit: 10 }])
  })

  it('omits absent knobs and clamps the limit to the core ceiling', async () => {
    const { context, calls } = harnessWithCalls()
    await send(context, 'GET', '/obsidian-mem/audit')
    await send(context, 'GET', '/obsidian-mem/audit?limit=99999')
    expect(calls.audit).toEqual([{}, { limit: 500 }])
  })

  it('rejects an unknown view and a non-positive limit with 400', async () => {
    const { context, calls } = harnessWithCalls()
    const badView = await send(context, 'GET', '/obsidian-mem/audit?view=surprise')
    expect(badView.status).toBe(400)
    expect(envelopeOf(badView.json).error.code).toBe('audit_invalid_view')
    const badLimit = await send(context, 'GET', '/obsidian-mem/audit?limit=0')
    expect(badLimit.status).toBe(400)
    expect(envelopeOf(badLimit.json).error.code).toBe('audit_invalid_limit')
    expect(calls.audit).toEqual([])
  })

  it('answers 500 audit_failed when the pass throws', async () => {
    const context = harness({ auditError: new Error('vault walk failed') })
    const response = await send(context, 'GET', '/obsidian-mem/audit')
    expect(response.status).toBe(500)
    expect(envelopeOf(response.json).error.code).toBe('audit_failed')
  })
})

describe('dream endpoints', () => {
  it('GET plan answers the deterministic plan without running', async () => {
    const { context, calls } = harnessWithCalls()
    const response = await send(context, 'GET', '/obsidian-mem/dream/plan')
    expect(response.status).toBe(200)
    expect((response.json as { plan: { generatedAt: number } }).plan.generatedAt).toBe(1_700_000_000_000)
    expect(calls.dream).toEqual([{ operation: 'plan' }])
  })

  it('GET plan answers the structured unavailable while no agents gateway exists', async () => {
    const context = harness({
      status: () => baseStatus({
        dream: { state: 'idle', blocked: 'the host provides no agents service, so no dream agent can run (mount dsh-agent and an agent driver)', lastDreamAt: null, lastRun: null },
      }),
    })
    const response = await send(context, 'GET', '/obsidian-mem/dream/plan')
    expect(response.status).toBe(503)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('dream_unavailable')
    expect(body.error.message).toContain('no agents service')
  })

  it('GET plan maps a mid-flight DreamBlockedError to 503, never a 500', async () => {
    const context = harness({ dreamError: new DreamBlockedError('gateway vanished') })
    const response = await send(context, 'GET', '/obsidian-mem/dream/plan')
    expect(response.status).toBe(503)
    expect(envelopeOf(response.json).error.code).toBe('dream_unavailable')
  })

  it('GET plan answers 500 dream_failed for an unexpected throw', async () => {
    const context = harness({ dreamError: new Error('inventory walk died') })
    const response = await send(context, 'GET', '/obsidian-mem/dream/plan')
    expect(response.status).toBe(500)
    expect(envelopeOf(response.json).error.code).toBe('dream_failed')
  })

  it('POST run launches and answers 202 without awaiting the run', async () => {
    let settle: (value: ReturnType<typeof dreamSummary>) => void = () => undefined
    const context = new FakeCordisContext({ obsidianMem: makeRouteServiceWithCalls({
      dreamResult: {
        operation: 'run',
        id: 'dream-1',
        done: new Promise((resolve) => { settle = resolve }),
      },
    }).service })
    plugin.apply(context as unknown as Context)
    const response = await send(context, 'POST', '/obsidian-mem/dream/run', {})
    expect(response.status).toBe(202)
    expect(response.json).toEqual({ started: true, id: 'dream-1' })
    expect(context.loggerService.infos).toEqual([])
    settle(dreamSummary('dream-1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.loggerService.infos.some((line) => line.includes('dream run dream-1 finished'))).toBe(true)
  })

  it('POST run keeps the swallowing catch on the failing done promise', async () => {
    const context = harness({
      dreamResult: { operation: 'run', id: 'dream-2', done: Promise.reject(new Error('agent died mid-dream')) },
    })
    const response = await send(context, 'POST', '/obsidian-mem/dream/run', {})
    expect(response.status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.loggerService.warns.some((line) => line.includes('agent died mid-dream'))).toBe(true)
  })

  it('POST run answers the guarded unavailable when the gateway is missing', async () => {
    const { context, calls } = harnessWithCalls({
      status: () => baseStatus({
        dream: { state: 'idle', blocked: 'the host provides no agents service', lastDreamAt: null, lastRun: null },
      }),
    })
    const response = await send(context, 'POST', '/obsidian-mem/dream/run', {})
    expect(response.status).toBe(503)
    expect(envelopeOf(response.json).error.code).toBe('dream_unavailable')
    expect(calls.dream).toEqual([])
  })

  it('POST run maps a busy guard to 409 dream_busy', async () => {
    const context = harness({ dreamError: new DreamBusyError('a dream is already in progress (state: running)') })
    const response = await send(context, 'POST', '/obsidian-mem/dream/run', {})
    expect(response.status).toBe(409)
    expect(envelopeOf(response.json).error.code).toBe('dream_busy')
  })

  it('POST run forwards an optional model and rejects a non-string one', async () => {
    const { context, calls } = harnessWithCalls({
      dreamResult: { operation: 'run', id: 'dream-3', done: Promise.resolve(dreamSummary('dream-3')) },
    })
    await send(context, 'POST', '/obsidian-mem/dream/run', { model: 'deepseek-chat' })
    expect(calls.dream).toEqual([{ operation: 'run', model: 'deepseek-chat' }])
    const bad = await send(context, 'POST', '/obsidian-mem/dream/run', { model: 42 })
    expect(bad.status).toBe(400)
  })

  it('GET state answers lastDreamAt and promptPath', async () => {
    const context = harness()
    const response = await send(context, 'GET', '/obsidian-mem/dream/state')
    expect(response.status).toBe(200)
    expect(response.json).toEqual({
      lastDreamAt: 1_700_000_000_000,
      promptPath: '/home/u/.dsh/obsidian-mem-db/dream-prompt.md',
    })
  })

  it('GET state answers the envelope when the seam throws', async () => {
    const context = harness({ status: () => { throw new Error('stamp read failed') } })
    const response = await send(context, 'GET', '/obsidian-mem/dream/state')
    expect(response.status).toBe(500)
    expect(envelopeOf(response.json).error.message).toBe('stamp read failed')
  })
})

describe('/obsidian-mem/dreaming/schedules', () => {
  /** Mount with a schedule gateway (or null for a profile without one). */
  function scheduleHarness(
    options: Parameters<typeof makeScheduleGateway>[0] = {},
    gatewayOptions: Parameters<typeof makeScheduleGateway>[0] & { absent?: boolean } = {},
  ): { context: FakeCordisContext, calls: ReturnType<typeof makeScheduleGateway>['calls'] } {
    const { absent, ...gatewayKnobs } = gatewayOptions
    const made = makeScheduleGateway({ ...options, ...gatewayKnobs })
    const context = new FakeCordisContext({
      obsidianMem: makeRouteServiceWithCalls().service,
      schedule: absent ? undefined : made.gateway,
    })
    plugin.apply(context as unknown as Context)
    return { context, calls: made.calls }
  }

  it('GET lists only the plugin-owned entries and echoes the config schedules', async () => {
    const { context } = scheduleHarness()
    const response = await send(context, 'GET', '/obsidian-mem/dreaming/schedules')
    expect(response.status).toBe(200)
    const body = response.json as {
      entries: { pluginId: string, title: string, scheduleId?: string, id: string }[]
      configured: { id: string, label: string }[]
    }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]!.pluginId).toBe('nightly')
    expect(body.entries[0]!.id).toBe('task-1')
    expect(body.configured).toEqual([{ id: 'nightly', label: 'Nightly sweep', everySeconds: 86_400 }])
  })

  it('POST upserts under the namespaced title, replacing the prior entry', async () => {
    const { context, calls } = scheduleHarness()
    const response = await send(context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'nightly', label: 'Nightly sweep', sessionId: 'sess-9', everySeconds: 86_400,
    })
    expect(response.status).toBe(200)
    const body = response.json as { id: string, replaced: boolean, entry: { title: string } }
    expect(body.id).toBe('nightly')
    expect(body.replaced).toBe(true)
    expect(calls.delete).toEqual([{ sessionId: 'sess-1', id: 'task-1' }])
    expect(calls.create).toHaveLength(1)
    const created = calls.create[0]!
    expect(created.sessionId).toBe('sess-9')
    const request = created.request as Record<string, unknown>
    expect(request['title']).toBe('obsidian-mem dream:nightly')
    expect(request['every_seconds']).toBe(86_400)
    expect(String(request['prompt'])).toContain('memory_dream')
    expect(String(request['prompt'])).toContain('Nightly sweep')
  })

  it('POST upserts a cron expression in the requested zone (UTC default)', async () => {
    const first = scheduleHarness()
    await send(first.context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'weekly', label: 'Weekly', sessionId: 'sess-9', expression: '0 3 * * 1',
    })
    expect((first.calls.create[0]!.request as { cron: unknown }).cron)
      .toEqual({ expression: '0 3 * * 1', time_zone: 'UTC' })

    const second = scheduleHarness()
    await send(second.context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'weekly', label: 'Weekly', sessionId: 'sess-9', expression: '0 3 * * 1', timeZone: 'America/Los_Angeles',
    })
    expect((second.calls.create[0]!.request as { cron: { time_zone: string } }).cron.time_zone)
      .toBe('America/Los_Angeles')
  })

  it('POST validates the body before touching the gateway', async () => {
    const { context, calls } = scheduleHarness()
    const cases: Record<string, unknown>[] = [
      { id: 'ok', label: 'L', sessionId: 's' }, // no timing
      { id: 'ok', label: 'L', sessionId: 's', expression: '* * * * *', everySeconds: 120 }, // both
      { id: 'ok', label: 'L', sessionId: 's', everySeconds: 30 }, // below the 60 s floor
      { id: 'bad id!', label: 'L', sessionId: 's', everySeconds: 120 }, // unsafe id
      { id: 'ok', label: '  ', sessionId: 's', everySeconds: 120 }, // blank label
      { id: 'ok', label: 'L', everySeconds: 120 }, // no sessionId
    ]
    for (const body of cases) {
      const response = await send(context, 'POST', '/obsidian-mem/dreaming/schedules', body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(envelopeOf(response.json).error.code).toBe('schedule_invalid')
    }
    expect(calls.create).toEqual([])
    expect(calls.delete).toEqual([])
  })

  it('POST maps ScheduleInputError codes and subagent_session as the service spells them', async () => {
    const rejected = scheduleHarness({}, {
      createError: Object.assign(new Error('every_seconds is below the one minute floor'), {
        code: 'frequency_too_high',
      }),
    })
    const tooFast = await send(rejected.context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'fast', label: 'Fast', sessionId: 's', everySeconds: 61,
    })
    expect(tooFast.status).toBe(400)
    expect(envelopeOf(tooFast.json).error.code).toBe('frequency_too_high')

    const subagent = scheduleHarness({}, {
      createError: Object.assign(new Error('a delegated child owns that session'), {
        code: 'subagent_session',
      }),
    })
    const wrongSession = await send(subagent.context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'ok', label: 'Ok', sessionId: 'child', everySeconds: 120,
    })
    expect(wrongSession.status).toBe(409)
    expect(envelopeOf(wrongSession.json).error.code).toBe('subagent_session')

    const unknown = scheduleHarness({}, { createError: new Error('storage exploded') })
    const failed = await send(unknown.context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'ok', label: 'Ok', sessionId: 's', everySeconds: 120,
    })
    expect(failed.status).toBe(500)
    expect(envelopeOf(failed.json).error.code).toBe('schedule_failed')
  })

  it('DELETE removes an owned trigger after proving the title', async () => {
    const { context, calls } = scheduleHarness()
    const response = await send(context, 'DELETE', '/obsidian-mem/dreaming/schedules', { id: 'nightly' })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ deleted: true, id: 'nightly' })
    expect(calls.delete).toEqual([{ sessionId: 'sess-1', id: 'task-1' }])
  })

  it('DELETE never touches a foreign entry and answers 404 schedule_not_found', async () => {
    const { context, calls } = scheduleHarness()
    const response = await send(context, 'DELETE', '/obsidian-mem/dreaming/schedules', { id: 'foreign-1' })
    expect(response.status).toBe(404)
    expect(envelopeOf(response.json).error.code).toBe('schedule_not_found')
    expect(calls.delete).toEqual([])
  })

  it('DELETE answers 404 when the service reports the row already gone', async () => {
    const { context } = scheduleHarness({}, { deleteResult: { deleted: false } })
    const response = await send(context, 'DELETE', '/obsidian-mem/dreaming/schedules', { id: 'nightly' })
    expect(response.status).toBe(404)
    expect(envelopeOf(response.json).error.code).toBe('schedule_not_found')
  })

  it('every method answers 503 schedule_unavailable without the schedule service', async () => {
    const { context } = scheduleHarness({}, { absent: true })
    const get = await send(context, 'GET', '/obsidian-mem/dreaming/schedules')
    expect(get.status).toBe(503)
    expect(envelopeOf(get.json).error.code).toBe('schedule_unavailable')
    const post = await send(context, 'POST', '/obsidian-mem/dreaming/schedules', {
      id: 'ok', label: 'Ok', sessionId: 's', everySeconds: 120,
    })
    expect(post.status).toBe(503)
    expect(envelopeOf(post.json).error.code).toBe('schedule_unavailable')
    const del = await send(context, 'DELETE', '/obsidian-mem/dreaming/schedules', { id: 'ok' })
    expect(del.status).toBe(503)
    expect(envelopeOf(del.json).error.code).toBe('schedule_unavailable')
  })
})

describe('GET /obsidian-mem/search', () => {
  it('probes the index and answers results with the effective knobs', async () => {
    const { context, calls } = harnessWithCalls({ searchResults: [searchRow('a.md'), searchRow('b.md')] })
    const response = await send(context, 'GET', '/obsidian-mem/search?q=retry+budget')
    expect(response.status).toBe(200)
    const body = response.json as { results: unknown[], query: string, topK: number }
    expect(body.results).toHaveLength(2)
    expect(body.query).toBe('retry budget')
    expect(body.topK).toBe(10)
    expect(calls.search).toEqual([{ query: 'retry budget', topK: 10 }])
  })

  it('honours and clamps topK within the 10-row card ceiling', async () => {
    const { context, calls } = harnessWithCalls()
    await send(context, 'GET', '/obsidian-mem/search?q=x&topK=3')
    await send(context, 'GET', '/obsidian-mem/search?q=x&topK=50')
    expect(calls.search.map((request) => request.topK)).toEqual([3, 10])
    const bad = await send(context, 'GET', '/obsidian-mem/search?q=x&topK=abc')
    expect(bad.status).toBe(400)
    expect(envelopeOf(bad.json).error.code).toBe('search_invalid')
  })

  it('requires a query', async () => {
    const { context, calls } = harnessWithCalls()
    for (const url of ['/obsidian-mem/search', '/obsidian-mem/search?q=', '/obsidian-mem/search?q=%20']) {
      const response = await send(context, 'GET', url)
      expect(response.status, url).toBe(400)
      expect(envelopeOf(response.json).error.code).toBe('search_invalid')
    }
    expect(calls.search).toEqual([])
  })

  it('maps the typed offline error to 503 index_offline', async () => {
    const context = harness({ searchError: new IndexOfflineError('memory index is offline') })
    const response = await send(context, 'GET', '/obsidian-mem/search?q=x')
    expect(response.status).toBe(503)
    const body = envelopeOf(response.json)
    expect(body.error.code).toBe('index_offline')
    expect(body.error.message).toContain('offline')
  })

  it('maps any other failure to 500 search_failed', async () => {
    const context = harness({ searchError: new Error('embedder download failed') })
    const response = await send(context, 'GET', '/obsidian-mem/search?q=x')
    expect(response.status).toBe(500)
    expect(envelopeOf(response.json).error.code).toBe('search_failed')
  })
})

describe('ROUTES contract', () => {
  it('declares only routes that are mounted, and mounts exactly the contract paths', () => {
    const context = harness()
    const declared = new Map<string, string[]>()
    for (const route of ROUTES) {
      const listed = declared.get(route.path)
      if (listed === undefined) declared.set(route.path, [route.method])
      else listed.push(route.method)
    }
    expect([...declared.keys()].sort()).toEqual(
      context.webServer.records.map((record) => record.path).sort(),
    )
  })

  it('every contract endpoint answers something other than the route-absent error', async () => {
    const context = harness()
    for (const route of ROUTES) {
      const query = route.path === '/obsidian-mem/search' ? '?q=x'
        : route.path === '/obsidian-mem/audit' ? '?view=full'
          : ''
      const response = await send(context, route.method, `${route.path}${query}`)
      expect(response.status, `${route.method} ${route.path}`).not.toBe(405)
      expect([200, 201, 202, 400, 409, 503]).toContain(response.status)
    }
  })
})
