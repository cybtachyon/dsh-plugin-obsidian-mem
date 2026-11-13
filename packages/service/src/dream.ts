/**
 * The dreaming engine (TASK-035, the service side of `memory_dream`).
 * `plan` is the deterministic candidate analysis sharing the audit
 * engine's note inventory and budget math; `run` launches a dedicated
 * dream agent through the reflection gateway `ctx.get('agents')` only
 * (never a typed import of agents internals), following the engramory-ext
 * §2.6 sequence: single flight armed synchronously before the first await,
 * session `dream-<uuid>` created with a resolved provider/model
 * `AgentOptions` (model precedence: per-run override, then config
 * `dreaming.model`, then the host default model; the provider comes only
 * from the host default, so a model override never changes the provider
 * route), followup then whenIdle then dispose, and a deterministic
 * post-pass that re-scores relevancy purely from frontmatter read
 * evidence, THEN stamps lastDreamAt (order load-bearing).
 *
 * Git-churn stressors are a documented deviation from the ext: vaults are
 * not necessarily git repos here, so stress is read-staleness, staleness
 * vs lastDreamAt, and near-duplicate vector similarity only. The dream
 * agent moves memory through memory_read/memory_write (service applyWrite);
 * the only files this engine writes are plugin-owned: the editable prompt
 * seed, the state stamp, the relevancy sidecar, and the DREAMS.md diary
 * fallback. Archive candidates are flagged, never auto-deleted.
 * @module dsh-plugin-obsidian-mem/service/dream
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  ARCHIVE_HISTORY_SUFFIX,
  dbStateDir,
  DEGRADATION_STEP,
  DREAM_PROMPT_FILE,
  DREAM_SESSION_PREFIX,
  DREAMS_FILE,
  metadataDir,
  NOTE_TIMELINE_BYTES,
  PLUGIN_METADATA_REL,
  RELEVANCY_BUMP_TARGET,
  RELEVANCY_FILE,
  SCOPE_GLOBAL,
  VAULT_MODE_SHARED,
} from '../../core/lib/index.js'
import type { VaultMode } from '../../core/lib/index.js'
import type { ResolvedObsidianMemConfig } from './config.js'
import { describeError } from './errors.js'
import { budgetProtectedOnly, dayEnd, dreamStatePath, globalBudgetReport, globalFileTargets, readLastDreamAt } from './audit.js'
import type { AuditedNote, GlobalBudgetReport, VaultInventory } from './audit.js'
import type { GlobalMemoryIndex, ServiceFs } from './service.js'

/**
 * DEFAULT_DREAM_PROMPT seeds `<dbDir>/dream-prompt.md` once. The seeded
 * file keeps the `{{...}}` tunable placeholders; every load renders them
 * from the CURRENT resolved config, so user edits survive and tunables
 * follow config changes (ext seed-once + render-on-load pattern). It ships
 * as a TS constant because installs carry build output (lib), not source
 * assets.
 */
export const DEFAULT_DREAM_PROMPT = `# Obsidian Mem: dreaming protocol

You are the dreaming agent for the user's shared memory vaults. Work only
through the memory tools: open notes with memory_read, write with
memory_write (never raw shell or file tools), and never delete a note:
retire it by writing it back with archive=true.

Ground rules:
- Resolve contradictions toward the newer, more relevant memory; fold the
  older information into the surviving note as background.
- Merge near-duplicate notes: keep the richer note, move every unique fact
  into it, then archive=true on the others.
- A note larger than {{NOTE_TIMELINE_BYTES}} bytes is a timeline: keep the
  conclusion in the note and move the history into a note named after it
  with the suffix {{ARCHIVE_HISTORY_SUFFIX}} at the vault root (reserved,
  never indexed).
- After each step, append a dated section "## <YYYY-MM-DD> Step <N>: <step
  name>" to DREAMS.md in the first shared vault's ${PLUGIN_METADATA_REL}/
  directory. The diary is a log: never treat it as a memory source and
  never write memory notes into it.
- Never change the frontmatter fields read_count or last_read_at; the
  plugin scores relevancy deterministically after this run.

Steps, in order:
1. Post-cognition: for the notes the work plan touches, retitle
   index_title to the reader's next action in "Topic: Scenario" form,
   tighten index_description to the recall hook that decides whether to
   open the note, and keep the body settled facts only.
2. Abstraction: for each surviving note, imagine the future scenario that
   would need it; correct whatever that scenario exposes as wrong, vague,
   or stale.
3. Post-cognition again: repeat step 1; step 2 churned the notes.
4. Forgetting: for each near-duplicate cluster, merge and archive the
   losers; for each stale or never-read candidate, verify it and set
   archive=true when it no longer holds.

Global memory injection budget: {{GLOBAL_MEMORY_TOKENS}} tokens.
Near-duplicate cosine threshold: {{NEAR_DUPLICATE_THRESHOLD}}.
`

// ---------------------------------------------------------------------------
// Public shapes.

/** One dreaming request; `plan` never calls a model, `run` launches one. */
export interface DreamRequest {
  operation?: 'plan' | 'run'
  /**
   * Per-run model override; empty counts as unset and falls through to
   * config dreaming.model, then the host default model. It never changes
   * the provider route, which only the host default supplies.
   */
  model?: string
}

/** A note the plan proposes work for. */
export interface DreamCandidate {
  path: string
  vaultPath: string
  /** Vault-relative posix path: the vector lookup key (source_path). */
  rel: string
  mode: VaultMode
  reasons: string[]
  readCount: number
  lastReadAt: string
  sizeBytes: number
}

/** The deterministic plan: prompt, ranked work, clusters, budget math. */
export interface DreamPlan {
  generatedAt: number
  lastDreamAt: number | null
  /** Current editable prompt, tunables rendered (what a run would send). */
  prompt: string
  /** Numbered work plan text (also the run message's work section). */
  plan: string
  candidates: DreamCandidate[]
  clusters: string[][]
  stats: {
    notes: number
    globalNotes: number
    oversized: number
    staleOrUnread: number
    totalBytes: number
  }
  budget: GlobalBudgetReport
  skipped: string[]
}

/** What one completed (or failed) run recorded for status and audit. */
export interface DreamRunSummary {
  id: string
  startedAt: number
  finishedAt: number
  ok: boolean
  notes: number
  bumped: number
  degraded: number
  /** Flagged for the next review; the engine never archives by itself. */
  archiveCandidates: string[]
  /** One-line outcome, diary and status appropriate. */
  summary: string
  error: string | null
}

/** The immediate answer of a launched run; attach a swallowing catch. */
export interface DreamRunHandle {
  id: string
  done: Promise<DreamRunSummary>
}

/** The seam answer for any dream request, discriminated by operation. */
export type DreamEngineResult
  = { operation: 'plan', plan: DreamPlan }
  | { operation: 'run', id: string, done: Promise<DreamRunSummary> }

/** Thrown when a second run arrives while one is in flight. */
export class DreamBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamBusyError'
  }
}

/** Thrown when no agents service exists to host the dream agent. */
export class DreamBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DreamBlockedError'
  }
}

/** The reflection-gateway slice of the host `agents` service (never typed). */
export interface DreamAgentsGateway {
  create(options: {
    sessionId: string
    agentOptions?: { provider?: string, model?: string }
  }): Promise<DreamAgentHandle>
}

/**
 * The reflection-gateway slice of the host `agentDefaultModel` service
 * (never typed; TASK-002 wiring). The structural shape matches the
 * `dsh-headless` `ctx.get("agentDefaultModel").currentSelection():
 * ModelSelection`.
 */
export interface DreamDefaultModelGateway {
  currentSelection(): { provider: string, model: string }
}

export interface DreamAgentHandle {
  agent: {
    followup(message: unknown): unknown
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void> | void
}

/** A note the plan needs stored vectors for, keyed by absolute path. */
export interface DreamVectorTarget {
  path: string
  vaultPath: string
  rel: string
}

/** Everything external is injected: no os, no cordis imports in the class. */
export interface DreamDeps {
  /** Plugin-owned file writes (prompt seed, stamp, sidecar, diary). */
  fs: ServiceFs
  config: ResolvedObsidianMemConfig
  /** Live note inventories from the audit enumeration (read-only seam). */
  inventories: () => VaultInventory[]
  globalIndex: () => GlobalMemoryIndex & { overBudget?: boolean }
  /** Reflection gateway: undefined until an agents service mounts. */
  agentsGateway: () => DreamAgentsGateway | undefined
  /**
   * Host default provider/model route for spawned agents; undefined when
   * the host offers no default-model service. It is the only provider
   * source: model overrides never change the provider route.
   */
  defaultAgentOptions: () => { provider?: string, model?: string } | undefined
  /** Stored chunk vectors averaged per note; empty map when index cold. */
  noteVectors: (targets: readonly DreamVectorTarget[]) => Promise<Map<string, number[]>>
  log: (message: string) => void
}

// Candidate reason codes: these strings are model-facing (the plan's
// candidate reasons and work lines) and every ranking and plan-shaping
// decision reads them from here (single home for the values).
const REASON_GLOBAL_OVER_BUDGET = 'global-over-budget'
const REASON_OVERSIZED_TIMELINE = 'oversized-timeline'
const REASON_NEVER_READ = 'never-read'
const REASON_UNREAD_SINCE_DREAM = 'unread-since-last-dream'

/** The reasons that mark a candidate as stale-or-unread plan work. */
const STALE_REASONS: readonly string[] = [REASON_NEVER_READ, REASON_UNREAD_SINCE_DREAM]

// Candidate ranking weights keyed by reason; heavier acts first in the
// work plan.
const CANDIDATE_WEIGHTS: Record<string, number> = {
  [REASON_GLOBAL_OVER_BUDGET]: 4,
  [REASON_OVERSIZED_TIMELINE]: 3,
  [REASON_NEVER_READ]: 2,
  [REASON_UNREAD_SINCE_DREAM]: 2,
}

/** Work lists in the plan text stay bounded; the stats never lie about it. */
const PLAN_CANDIDATE_CAP = 25
const VECTOR_TARGET_CAP = 24
const ARCHIVE_CANDIDATE_CAP = 50

// Relevancy decay is rounded to three decimals; the scale is that rounding.
const RELEVANCY_DECAY_SCALE = 1000

// Shared by blockedReason and the launch guard so the card banner and a
// raced launch report one provider/model resolution failure.
const NO_AGENT_MODEL_ROUTE = 'no provider/model can be resolved for the dream agent (mount the host agentDefaultModel service or set dreaming.model)'

/** The deterministic post-pass counts, recorded onto DreamRunSummary. */
interface DreamScoring {
  notes: number
  bumped: number
  degraded: number
  archiveCandidates: string[]
}

/** Cosine-similarity union-find clusters over the candidate vectors. */
function similarityClusters(
  paths: readonly string[],
  vectors: ReadonlyMap<string, number[]>,
  threshold: number,
): string[][] {
  const usable = paths.filter((path) => vectors.has(path))
  const parent = new Map<string, string>(usable.map((path) => [path, path]))
  const rootOf = (path: string): string => {
    let current = path
    for (;;) {
      const next = parent.get(current) ?? current
      if (next === current) {
        return current
      }
      current = next
    }
  }
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const first = usable[i] as string
      const second = usable[j] as string
      if (cosine(vectors.get(first) as number[], vectors.get(second) as number[]) < threshold) {
        continue
      }
      const rootFirst = rootOf(first)
      const rootSecond = rootOf(second)
      if (rootFirst !== rootSecond) {
        parent.set(rootSecond, rootFirst)
      }
    }
  }
  const groups = new Map<string, string[]>()
  for (const path of usable) {
    const root = rootOf(path)
    const group = groups.get(root) ?? []
    group.push(path)
    groups.set(root, group)
  }
  return [...groups.values()].filter((group) => group.length > 1).sort()
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number)
    normA += (a[i] as number) ** 2
    normB += (b[i] as number) ** 2
  }
  if (normA === 0 || normB === 0) {
    return 0
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** FirstNonEmpty returns the first non-empty string argument, else undefined. */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '')
}

/**
 * DreamOrchestrator holds the ONE single-flight guard that converges the
 * tool, the settings-card button, and scheduled triggers (ext §2.6): the
 * state is armed synchronously before the first await of a run, so two
 * concurrent run requests cannot both slip through.
 */
export class DreamOrchestrator {
  private readonly deps: DreamDeps
  private state: 'idle' | 'running' = 'idle'
  private lastSummaryValue: DreamRunSummary | null = null

  constructor(deps: DreamDeps) {
    this.deps = deps
  }

  /** The summary of the most recent run, or null before the first. */
  get lastSummary(): DreamRunSummary | null {
    return this.lastSummaryValue
  }

  /** True while a run owns the guard. */
  get busy(): boolean {
    return this.state === 'running'
  }

  /**
   * Why no run can start at all (no agents gateway, or no provider/model
   * pair resolves from config plus the host default); null when ready.
   */
  blockedReason(): string | null {
    if (this.deps.agentsGateway() === undefined) {
      return 'the host provides no agents service, so no dream agent can run (mount dsh-agent and an agent driver)'
    }
    const route = this.agentLaunchOptions()
    if (route.provider === undefined || route.model === undefined) {
      return NO_AGENT_MODEL_ROUTE
    }
    return null
  }

  /** Absolute path of the editable dream prompt (seeded on first use). */
  promptPath(): string {
    return join(this.deps.config.milvus.dbPath, DREAM_PROMPT_FILE)
  }

  /** Editable prompt file content with tunables rendered for this config. */
  loadPrompt(): string {
    const path = this.promptPath()
    const existing = this.deps.fs.readFile(path)
    if (existing !== null) {
      return renderPromptTunables(existing, this.deps.config)
    }
    this.deps.fs.mkdirp(dirname(path))
    this.deps.fs.writeFile(path, DEFAULT_DREAM_PROMPT)
    return renderPromptTunables(DEFAULT_DREAM_PROMPT, this.deps.config)
  }

  /** Last dream stamp (<dbDir>/state/state.json), null when never. */
  lastDreamAt(): number | null {
    return readLastDreamAt(this.deps.fs, this.deps.config.milvus.dbPath)
  }

  /**
   * Plan is the deterministic analysis (no model call): ranked candidates
   * from read-staleness and bloat heuristics, near-duplicate clusters from
   * stored vectors when the index answers, and the global budget section
   * with its headroom math.
   */
  async plan(): Promise<DreamPlan> {
    const generatedAt = Date.now()
    const inventories = this.deps.inventories()
    const allNotes = inventories.flatMap((inventory) => inventory.notes)
    const lastDreamAt = this.lastDreamAt()
    const vaults = inventories.map((inventory) => inventory.vault)
    const budget = globalBudgetReport(allNotes, vaults, this.deps.globalIndex())
    const skipped: string[] = []

    // TASK-015: a vault's own globalFile note is never a candidate, so it
    // lands in no work list, no timeline pick, no review pick, and never a
    // near-duplicate cluster (clusters only span candidates).
    const protectedTargets = globalFileTargets(vaults)
    const candidates: DreamCandidate[] = []
    for (const inventory of inventories) {
      for (const note of inventory.notes) {
        if (protectedTargets.has(note.path)) {
          continue
        }
        const candidate = rankCandidate(note, inventory.vault.mode, budget.overBudget, lastDreamAt)
        if (candidate !== null) {
          candidates.push(candidate)
        }
      }
    }
    candidates.sort((a, b) => candidateScore(b) - candidateScore(a) || (a.path < b.path ? -1 : 1))
    const chosen = candidates.slice(0, PLAN_CANDIDATE_CAP)

    const targets: DreamVectorTarget[] = chosen
      .slice(0, VECTOR_TARGET_CAP)
      .map((candidate) => ({ path: candidate.path, vaultPath: candidate.vaultPath, rel: candidate.rel }))
    let clusters: string[][] = []
    if (targets.length === 0) {
      if (allNotes.length > 0) {
        skipped.push('near-duplicate analysis (no candidates to compare)')
      }
    } else {
      const vectors = await this.deps.noteVectors(targets)
      if (vectors.size === 0) {
        skipped.push('near-duplicate analysis (no stored vectors available: the vector index is cold or the candidates are unindexed)')
      } else {
        clusters = similarityClusters(targets.map((target) => target.path), vectors, this.nearDuplicateThreshold())
      }
    }

    const oversized = allNotes.filter((note) => !note.flaggedNotRead && note.sizeBytes > NOTE_TIMELINE_BYTES)
    const staleOrUnread = candidates.filter((candidate) => candidate.reasons.some((reason) => STALE_REASONS.includes(reason)))

    return {
      generatedAt,
      lastDreamAt,
      prompt: this.loadPrompt(),
      plan: renderPlanText({ chosen, clusters, budget, skipped }),
      candidates: chosen,
      clusters,
      stats: {
        notes: allNotes.length,
        globalNotes: budget.globalNoteCount,
        oversized: oversized.length,
        staleOrUnread: staleOrUnread.length,
        totalBytes: inventories.reduce((sum, inventory) => sum + inventory.usageBytes, 0),
      },
      budget,
      skipped,
    }
  }

  /**
   * StartRun arms the single-flight guard synchronously (before the first
   * await) and returns the {id, done} pair immediately; the caller attaches
   * a swallowing logging catch to done and never awaits it inline. `done`
   * rejects when the run failed; the summary is recorded either way.
   */
  startRun(options: { model?: string } = {}): DreamRunHandle {
    const blocked = this.blockedReason()
    if (blocked !== null) {
      throw new DreamBlockedError(blocked)
    }
    if (this.state !== 'idle') {
      throw new DreamBusyError('a dream run is already in flight (orchestrator state running)')
    }
    const id = randomUUID()
    this.state = 'running'
    const done = this.drive(id, options.model)
    return { id, done }
  }

  private nearDuplicateThreshold(): number {
    return this.deps.config.dreaming.nearDuplicateThreshold
  }

  /**
   * AgentLaunchOptions is the single home of the launch model rule: the
   * model is the first non-empty of the per-run override, config
   * dreaming.model, and the host default model (empty string counts as
   * unset); the provider comes only from the host default selection, so
   * model overrides never change the provider route. blockedReason and
   * drive read the same resolution.
   */
  private agentLaunchOptions(modelOverride?: string): { provider: string | undefined, model: string | undefined } {
    const host = this.deps.defaultAgentOptions() ?? {}
    return {
      provider: host.provider,
      model: firstNonEmpty(modelOverride, this.deps.config.dreaming.model, host.model),
    }
  }

  /**
   * ApplyDreamScoring is the deterministic post-pass: relevancy is bumped
   * to the target from frontmatter read evidence newer than the PREVIOUS
   * stamp, tracked-but-unaccessed notes decay one step (floor 0), archive
   * candidates are flagged only, and only THEN is lastDreamAt stamped.
   */
  private applyDreamScoring(): DreamScoring {
    const lastDreamAt = this.lastDreamAt()
    const relevancy = this.readRelevancy()
    const allNotes = this.deps.inventories().flatMap((inventory) => inventory.notes)
    let bumped = 0
    let degraded = 0
    const archiveCandidates: string[] = []
    for (const note of allNotes) {
      if (note.meta === null || note.meta.archive === true) {
        continue
      }
      const last = note.meta.last_read_at ?? ''
      const readCount = note.meta.read_count ?? 0
      const accessed = lastDreamAt === null
        ? last !== '' || readCount > 0
        : last !== '' && dayEnd(last) > lastDreamAt
      const tracked = accessed || last !== '' || readCount > 0 || relevancy.has(note.path)
      if (!tracked) {
        continue
      }
      if (accessed) {
        relevancy.set(note.path, RELEVANCY_BUMP_TARGET)
        bumped += 1
        continue
      }
      const next = Math.max(0, Math.round(((relevancy.get(note.path) ?? 0) - DEGRADATION_STEP) * RELEVANCY_DECAY_SCALE) / RELEVANCY_DECAY_SCALE)
      relevancy.set(note.path, next)
      degraded += 1
      // Decay to zero is the archive-REVIEW flag; nothing is ever deleted.
      if (next === 0 && archiveCandidates.length < ARCHIVE_CANDIDATE_CAP) {
        archiveCandidates.push(note.path)
      }
    }
    this.writeRelevancy(relevancy)
    return { notes: allNotes.length, bumped, degraded, archiveCandidates }
  }

  private setLastDream(at: number): void {
    const path = dreamStatePath(this.deps.config.milvus.dbPath)
    this.deps.fs.mkdirp(dirname(path))
    this.deps.fs.writeFile(path, `${JSON.stringify({ lastDreamAt: at }, null, 2)}\n`)
  }

  // Path of the relevancy sidecar under the plugin state dir; read and
  // write share it so the two halves cannot name different files.
  private relevancyPath(): string {
    return join(dbStateDir(this.deps.config.milvus.dbPath), RELEVANCY_FILE)
  }

  private readRelevancy(): Map<string, number> {
    const path = this.relevancyPath()
    const raw = this.deps.fs.readFile(path)
    if (raw === null) {
      return new Map()
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    } catch (error: unknown) {
      // Recoverable score data, not a dead plugin: start empty, say so.
      this.deps.log(`relevancy sidecar unreadable (${path}): ${describeError(error)}; starting empty`)
      return new Map()
    }
  }

  private writeRelevancy(relevancy: Map<string, number>): void {
    const path = this.relevancyPath()
    const record: Record<string, number> = {}
    for (const key of [...relevancy.keys()].sort()) {
      record[key] = relevancy.get(key) as number
    }
    this.deps.fs.mkdirp(dirname(path))
    this.deps.fs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
  }

  // Diary fallback (ext seedDreamsDiary): create-once only, so the agent's
  // own appended sections are never touched. The diary sits in the vault's
  // sidecar dir (PLAN-vault-layout); parents are created here because a
  // pre-TASK-013 vault may not have `.obsidian-mem/metadata/` on disk yet.
  private seedDreamsDiary(id: string): void {
    const shared = this.deps.inventories().filter((inventory) => inventory.vault.mode === VAULT_MODE_SHARED && inventory.facts.exists)
    const first = shared[0]
    if (first === undefined) {
      return
    }
    const sidecar = metadataDir(first.vault.path)
    const diary = join(sidecar, DREAMS_FILE)
    if (this.deps.fs.exists(diary)) {
      return
    }
    const day = new Date().toISOString().slice(0, 10)
    this.deps.fs.mkdirp(sidecar)
    this.deps.fs.writeFile(diary, [
      '# Dream Diary',
      '',
      `## ${day} Dream (run ${id})`,
      '',
      'The dreaming agent recorded no diary sections for this run.',
      '',
    ].join('\n'))
  }

  private async drive(id: string, model: string | undefined): Promise<DreamRunSummary> {
    const startedAt = Date.now()
    const finish = (
      ok: boolean,
      error: string | null,
      scoring: DreamScoring | null,
    ): DreamRunSummary => {
      const summary: DreamRunSummary = {
        id,
        startedAt,
        finishedAt: Date.now(),
        ok,
        notes: scoring?.notes ?? 0,
        bumped: scoring?.bumped ?? 0,
        degraded: scoring?.degraded ?? 0,
        archiveCandidates: scoring?.archiveCandidates ?? [],
        summary: ok
          ? `dreamed ${String(scoring?.notes ?? 0)} notes: ${String(scoring?.bumped ?? 0)} bumped, ${String(scoring?.degraded ?? 0)} degraded, ${String(scoring?.archiveCandidates?.length ?? 0)} flagged for archive review`
          : `dream run failed: ${error ?? 'unknown error'}`,
        error,
      }
      this.lastSummaryValue = summary
      this.state = 'idle'
      return summary
    }

    try {
      const plan = await this.plan()
      const gateway = this.deps.agentsGateway()
      if (gateway === undefined) {
        throw new DreamBlockedError('the agents service disappeared before the run could launch')
      }
      const launchText = `${plan.prompt}\n---\n\n# Work plan for this run\n\n${plan.plan}\n\nVaults, budgets, and cluster detail above are authoritative; verify each candidate with memory_read before acting.\n`
      const route = this.agentLaunchOptions(model)
      if (route.provider === undefined || route.model === undefined) {
        // startRun's blockedReason already gates this; the host default
        // route is live, so re-check it at the moment of launch.
        throw new DreamBlockedError(NO_AGENT_MODEL_ROUTE)
      }
      const handle = await gateway.create({
        sessionId: `${DREAM_SESSION_PREFIX}${id}`,
        agentOptions: { provider: route.provider, model: route.model },
      })
      try {
        handle.agent.followup({ content: [{ type: 'text', text: launchText }], source: { kind: 'user' } })
        await handle.agent.whenIdle()
      } finally {
        await handle.dispose()
      }
      this.seedDreamsDiary(id)
      // Order load-bearing (ext): score against the PREVIOUS stamp, then
      // stamp lastDreamAt.
      const scoring = this.applyDreamScoring()
      this.setLastDream(Date.now())
      this.deps.log(`dream ${id} done: ${String(scoring.bumped)} bumped, ${String(scoring.degraded)} degraded, ${String(scoring.archiveCandidates.length)} archive candidates`)
      return finish(true, null, scoring)
    } catch (error: unknown) {
      const message = describeError(error)
      this.deps.log(`dream ${id} failed: ${message}`)
      finish(false, message, null)
      throw error instanceof Error ? error : new Error(message)
    }
  }
}

// ---------------------------------------------------------------------------
// Plan shaping helpers (pure; exported pieces serve the tool and tests).

function rankCandidate(
  note: AuditedNote,
  mode: VaultMode,
  overBudget: boolean,
  lastDreamAt: number | null,
): DreamCandidate | null {
  if (note.meta === null || note.meta.archive === true) {
    return null
  }
  const reasons: string[] = []
  const last = note.meta.last_read_at ?? ''
  const readCount = note.meta.read_count ?? 0
  if (last === '' && readCount === 0) {
    reasons.push(REASON_NEVER_READ)
  } else if (last !== '' && lastDreamAt !== null && dayEnd(last) <= lastDreamAt) {
    reasons.push(REASON_UNREAD_SINCE_DREAM)
  }
  if (!note.flaggedNotRead && note.sizeBytes > NOTE_TIMELINE_BYTES) {
    reasons.push(REASON_OVERSIZED_TIMELINE)
  }
  if (overBudget && note.meta.type === SCOPE_GLOBAL) {
    reasons.push(REASON_GLOBAL_OVER_BUDGET)
  }
  if (reasons.length === 0) {
    return null
  }
  return {
    path: note.path,
    vaultPath: note.vaultPath,
    rel: note.rel,
    mode,
    reasons,
    readCount,
    lastReadAt: last,
    sizeBytes: note.sizeBytes,
  }
}

function candidateScore(candidate: DreamCandidate): number {
  return candidate.reasons.reduce((sum, reason) => sum + (CANDIDATE_WEIGHTS[reason] ?? 0), 0)
}

function renderPlanText(input: {
  chosen: readonly DreamCandidate[]
  clusters: readonly (readonly string[])[]
  budget: GlobalBudgetReport
  skipped: readonly string[]
}): string {
  const lines: string[] = []
  let step = 0
  const next = (): string => {
    step += 1
    return `${String(step)}.`
  }
  const clustered = new Set(input.clusters.flat())
  if (input.chosen.length === 0 && input.clusters.length === 0 && !input.budget.overBudget) {
    return 'No candidates found: the store needs no compaction work this run.'
  }
  for (const cluster of input.clusters) {
    const [survivor, ...losers] = cluster
    for (const loser of losers) {
      lines.push(`${next()} Merge near-duplicate: memory_read ${String(survivor)} and ${loser}; write the merged note to ${String(survivor)} via memory_write, then memory_write ${loser} with archive=true.`)
    }
  }
  for (const candidate of input.chosen) {
    if (candidate.reasons.includes(REASON_OVERSIZED_TIMELINE) && !clustered.has(candidate.path)) {
      lines.push(`${next()} Split timeline ${candidate.path}: keep the conclusion in it and move the history into a ${candidate.path.replace(/\.md$/, '')}${ARCHIVE_HISTORY_SUFFIX} note at the vault root (reserved, never indexed).`)
    }
  }
  for (const candidate of input.chosen) {
    if (candidate.reasons.includes(REASON_GLOBAL_OVER_BUDGET)) {
      lines.push(`${next()} Compact global note ${candidate.path}: it injects into every session; tighten it to a conclusion pointer.`)
    }
  }
  for (const candidate of input.chosen) {
    const review = candidate.reasons.filter((reason) => STALE_REASONS.includes(reason))
    if (review.length === 0 || clustered.has(candidate.path)) {
      continue
    }
    const action = candidate.mode === VAULT_MODE_SHARED
      ? 'verify it with memory_read; correct it or set archive=true when it no longer holds'
      : 'its vault is read-only: raise the review with the user instead of editing'
    lines.push(`${next()} Review (${candidate.reasons.join(', ')}): ${candidate.path}: ${action}.`)
  }
  if (input.budget.overBudget) {
    if (budgetProtectedOnly(input.budget)) {
      lines.push(`${next()} Global memory is over budget (${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used), and every live global note is a vault global file the dreaming pass never compacts: compaction cannot help; manually tighten ${input.budget.globalNotePaths.join(', ')} to reclaim budget.`)
    } else {
      lines.push(`${next()} Global memory is over budget (${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used). ${String(input.budget.globalNoteCount)} live global notes inject; compact least-read first: ${input.budget.compactableGlobalNotePaths.join(', ')}.`)
    }
  } else {
    lines.push(`${next()} Global budget headroom: ${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used, ${String(input.budget.globalNoteCount)} live global notes.`)
  }
  for (const skip of input.skipped) {
    lines.push(`${next()} Skipped check: ${skip}.`)
  }
  return lines.join('\n')
}

/** RenderPromptTunables substitutes the {{PLACEHOLDER}}s from live config. */
export function renderPromptTunables(template: string, config: ResolvedObsidianMemConfig): string {
  return template
    .replaceAll('{{NOTE_TIMELINE_BYTES}}', String(NOTE_TIMELINE_BYTES))
    .replaceAll('{{ARCHIVE_HISTORY_SUFFIX}}', ARCHIVE_HISTORY_SUFFIX)
    .replaceAll('{{GLOBAL_MEMORY_TOKENS}}', String(config.budgets.globalMemoryTokens))
    .replaceAll('{{NEAR_DUPLICATE_THRESHOLD}}', String(config.dreaming.nearDuplicateThreshold))
}
