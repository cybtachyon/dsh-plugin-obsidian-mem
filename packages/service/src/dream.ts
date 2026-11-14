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
 * route), followup then whenIdle then a failed-turn scan of the session's
 * own records (agent-loop contains turn errors and whenIdle resolves
 * anyway, so a `turn/end` with `reason.kind === 'error'` throws before the
 * stamp and the post-pass; TASK-003), then dispose, and a deterministic
 * post-pass that re-scores relevancy purely from frontmatter read
 * evidence, THEN stamps lastDreamAt (order load-bearing) and only then
 * fires the optional `onRunSucceeded` dep, the ok-path global-budget
 * rebaseline (PLAN-budget-rebaseline TASK-002).
 *
 * Git (PLAN-git-versioning TASK-006): with config `git.enabled` the shared
 * vaults are git repos owned by the VaultGitManager; the launch text names
 * the adopted roots for the prompt's Step 0 Pre-Sync, the ok path closes
 * with one commitMemory pass over every shared vault, and the Step 4
 * churn stressors read git history at the `git.churnWindowCommits` window.
 * The dream agent moves memory through memory_read/memory_write (service
 * applyWrite); the only files this engine writes are plugin-owned: the
 * editable prompt seed, the state stamp, the relevancy sidecar, and the
 * DREAMS.md diary fallback (gitignored sidecar dir, never committed).
 * Archive candidates are flagged, never auto-deleted.
 * @module dsh-plugin-obsidian-mem/service/dream
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  ARCHIVE_HISTORY_SUFFIX,
  dbStateDir,
  DEGRADATION_STEP,
  DREAM_PROMPT_FILE,
  DREAM_RUN_SUGGESTION,
  DREAM_SESSION_PREFIX,
  DREAMS_FILE,
  MANUAL_COMPACTION_APPROVAL,
  MANUAL_COMPACTION_RECIPE,
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
import type { VaultGitCommitOutcome } from './vault-git.js'
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
 - Never change the frontmatter fields read_count or last_read_at; the
   plugin scores relevancy deterministically after this run.
 - After each step, append a dated section "## <YYYY-MM-DD> Step <N>: <step
   name>" to DREAMS.md in the first shared vault's ${PLUGIN_METADATA_REL}/
   directory. This is the only file to use the regular read and edit tools on.
   The diary is a plain file log: never treat it as a memory note and
   never write a memory note into it.
## Step 0: Pre-Sync

Synchronize the memory git repository before touching any memory:

1. Run \`git fetch\` in the memory root when a remote is configured. When no
   remote is configured, check the local state alone.
2. Merge or pull so the branch catches up with its remote. If the merge
   reports conflicts, resolve every one of them: read both sides and merge
   the content. Where the two sides disagree and the right merge is
   ambiguous, preserve both sides in the file rather than picking one.
3. Re-check until the branch is fully up to date and no unresolved merge
   remains.
4. Begin Step 1 only once the store is fully synced. Never edit a memory
   while a merge is open.

## Step 1: Post-Cognition

Light sleep.
Sort, rewrite, and tidy the store for the notes the work plan lists:

1. Re-sort: move data to where it is most relevant. A memory
   may be coalesced from several files into one, or split apart for cleaner
   relevancy.
2. Re-title: each memory index_title phrased as the reader's next action.
   Write the primary, most-unique verb keyword(s) for the topic, then the
   remaining relevant title words.
3. Review: Check memories for contradictions. Resolve cognitive dissonance
   toward the newer, more relevant information; keep the older information
   as background. Discard outdated, irrelevant, or dangling references.
4. Distill: remove fluff language, keeping the core semantic principles and 
   abstract learnings.
5. Tighten: Rewrite index_description to the recall hook that decides whether to
   open the note and keep the body settled facts only.
6. Make presentable: correct run-on sentences into short
   statements, put line breaks between ideas, use white-space formatting
   for complex ideas, and turn list-sentences into bulleted lists.
7. Layer: when one topic holds a large number of memories,
   place them in a subdirectory and add a topical overview pointer memory
   that directs the reader to the subdirectory's index. Move archived notes
   to the \`archive\` subdirectory.

## Step 2: Cognitive Abstraction

REM sleep.
Pressure-test each memory by simulating its use:

1. Think of the memory in the most abstract manner possible.
2. Imagine an example scenario that uses the memory together with the
   memories most likely related to it. Re-add to the abstraction the
   important details that affect its meaning.
3. Launch a subagent and ask it to reason about the scenario, providing it
   only the scenario and the relevant abstracted memories. This is a reasoning
   task only and must not result in any real change to the file system.
4. Compare the subagent's result against the original memory for semantic
   principles and learnings.
5. Correct whatever that scenario exposes as wrong, vague, or stale, then
   ensure the memory note covers lessons learned.

## Step 3: Post-Cognition Re-run

Post-cognition again: repeat step 1; step 2 churned the notes.

## Step 4: Long-Term Memory, Bias, and Forgetting

Deep sleep.
Settle relevancy, surface stressors, and forget on purpose:

1. Identify stressors: memories with high relevancy and consistent churn.
   From git history, a stressor is a file edited in over
   {{CHURN_THRESHOLD_PERCENT}}% of the last {{CHURN_WINDOW_COMMITS}}
   commits. Annotate each stressor with a set of investigative questions
   oriented toward reducing its future churn, and instruct future agents
   to resolve them at the next memory edit.
2. For each near-duplicate cluster, merge and archive the losers;
   for each stale or never-read candidate, verify it and set archive=true when 
   it no longer holds.

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

/**
 * DreamAgentRoute is the provider/model pair that travels together from the
 * host default selection, through the launch resolver, into
 * `agents.create`. Either half may be unresolved until the pair is complete.
 */
export interface DreamAgentRoute {
  provider?: string
  model?: string
}

/** The reflection-gateway slice of the host `agents` service (never typed). */
export interface DreamAgentsGateway {
  create(options: {
    sessionId: string
    agentOptions?: DreamAgentRoute
    /**
     * Durable session metadata forwarded unchanged to
     * `sessions.create().meta`: the validated absolute `cwd` decides the
     * persisted transcript bucket and is what makes the session
     * GUI-addressable (PLAN-dream-meta-cwd).
     */
    meta?: { cwd?: string }
  }): Promise<DreamAgentHandle>
}

/**
 * The reflection-gateway slice of the host `agentDefaultModel` service
 * (never typed; TASK-002 wiring). The structural shape matches the
 * `dsh-headless` `ctx.get("agentDefaultModel").currentSelection():
 * ModelSelection` (a live selection always answers both halves; the optional
 * fields let the resolver treat a partial answer as unresolved).
 */
export interface DreamDefaultModelGateway {
  currentSelection(): DreamAgentRoute
}

export interface DreamAgentHandle {
  agent: {
    followup(message: unknown): unknown
    whenIdle(): Promise<void>
    /**
     * Structural slice of the live agent's `readonly session: Session`
     * (`@deepseek-ai/dsh-agent` runtime-types): `ownEvents()` returns this
     * session's records. Declared optional because the runtime may not
     * carry it; a missing slice logs a warning, never a silent pass
     * (dream-launch TASK-003). `ownEvents()` is `@deprecated` in the
     * installed `@deepseek-ai/dsh-session` (0.2.1-alpha.3), like every
     * synchronous session-event read there, and no non-deprecated
     * same-scope read exists; a host removal lands here as the
     * missing-slice warning (dream-launch TASK-005 adjudication).
     */
    session?: {
      ownEvents(): readonly { type: string, data?: unknown }[]
    }
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
  defaultAgentOptions: () => DreamAgentRoute | undefined
  /** Stored chunk vectors averaged per note; empty map when index cold. */
  noteVectors: (targets: readonly DreamVectorTarget[]) => Promise<Map<string, number[]>>
  /**
   * CommitMemory records one git commit pass over every shared vault at
   * the end of the ok path (the service wires the VaultGitManager
   * commitAllShared seam; a disabled git gate answers the empty list). A
   * null hash means the vault tree was clean. The orchestrator catches
   * throws: git is the history book and can never flip a landed memory
   * run (PLAN-git-versioning TASK-006).
   */
  commitMemory: (message: string) => Promise<VaultGitCommitOutcome[]>
  /**
   * GitRoots lists the shared vault roots the git layer has adopted; the
   * launch text names them for the prompt's Step 0 Pre-Sync step only
   * when the list is non-empty (empty means git is off or nothing is
   * adopted yet).
   */
  gitRoots: () => string[]
  /**
   * Fires on the ok path only, right after the lastDreamAt stamp: the
   * service wires it to the session registry's budget reset, so a
   * successful compaction rebaselines the global recall window
   * (PLAN-budget-rebaseline TASK-002). A failed run, a busy or blocked
   * throw, and `plan` never reach it.
   */
  onRunSucceeded?: () => void
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

/** AsRecord narrows unknown session-event payload to a field bag. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * FailedTurnMessage returns the first `turn/end` record whose
 * `data.reason.kind` is 'error' as its `data.reason.error.message`
 * (empty or absent message reads as 'unknown error'); undefined when no
 * turn failed. The `turn/end` reason is a closed union whose error variant
 * always carries `{ message, code }`; the session slice here is
 * structural, so every hop is checked.
 */
function failedTurnMessage(events: readonly { type: string, data?: unknown }[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') {
      continue
    }
    const reason = asRecord(asRecord(event.data)?.reason)
    if (reason?.kind !== 'error') {
      continue
    }
    const message = asRecord(reason.error)?.message
    return typeof message === 'string' && message !== '' ? message : 'unknown error'
  }
  return undefined
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
   * The status-facing gate resolves without a per-run override (there is
   * no run at status time); drive re-checks the pair at launch with the
   * run's own override.
   */
  blockedReason(): string | null {
    if (this.deps.agentsGateway() === undefined) {
      return 'the host provides no agents service, so no dream agent can run (mount dsh-agent and an agent driver)'
    }
    if (this.launchRoute() === null) {
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
   * LaunchRoute is the single home of the launch model rule: the
   * model is the first non-empty of the per-run override, config
   * dreaming.model, and the host default model (empty string counts as
   * unset); the provider comes only from the host default selection, so
   * model overrides never change the provider route. Returns the complete
   * provider/model pair, or null when either half is unresolved;
   * blockedReason and drive read the pair from here and nowhere else.
   */
  private launchRoute(modelOverride?: string): { provider: string, model: string } | null {
    const host = this.deps.defaultAgentOptions() ?? {}
    const model = firstNonEmpty(modelOverride, this.deps.config.dreaming.model, host.model)
    if (host.provider === undefined || model === undefined) {
      return null
    }
    return { provider: host.provider, model }
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

  // AssertNoFailedTurn fails the run on the session log's own evidence:
  // any `turn/end` record whose `data.reason.kind` is 'error' throws with
  // its error message. agent-loop contains turn errors inside kick() and
  // whenIdle() still resolves, so without this scan a dead agent records
  // as success (dream-launch TASK-003). When the structural session slice
  // is absent at runtime the check is impossible: log a warning naming the
  // missing slice rather than silently passing.
  private assertNoFailedTurn(id: string, agent: DreamAgentHandle['agent']): void {
    const session = agent.session
    if (session === undefined || typeof session.ownEvents !== 'function') {
      const missing = session === undefined ? 'agent.session' : 'agent.session.ownEvents'
      this.deps.log(`dream ${id}: failed-turn check skipped, ${missing} is missing on the agent`)
      return
    }
    const message = failedTurnMessage(session.ownEvents())
    if (message !== undefined) {
      throw new Error(`dream agent turn failed: ${message}`)
    }
  }

  private async drive(id: string, model: string | undefined): Promise<DreamRunSummary> {
    const startedAt = Date.now()
    const finish = (
      ok: boolean,
      error: string | null,
      scoring: DreamScoring | null,
      gitOutcomes: readonly VaultGitCommitOutcome[] = [],
    ): DreamRunSummary => {
      // Git fold (TASK-006): committed vaults ride the summary as
      // `<vault>=<hash7>`; a clean tree reads `clean`, and the clause
      // appears only when the pass committed somewhere.
      const gitNote = gitOutcomes.some((outcome) => outcome.hash !== null)
        ? `; git: ${gitOutcomes.map((outcome) => `${outcome.vault}=${outcome.hash === null ? 'clean' : outcome.hash.slice(0, 7)}`).join(', ')}`
        : ''
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
          ? `dreamed ${String(scoring?.notes ?? 0)} notes: ${String(scoring?.bumped ?? 0)} bumped, ${String(scoring?.degraded ?? 0)} degraded, ${String(scoring?.archiveCandidates?.length ?? 0)} flagged for archive review${gitNote}`
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
      // Step 0 Pre-Sync tells the agent to run `git fetch` in the memory
      // root; the roots line names WHERE (the adopted shared vaults), one
      // line, only while the git layer actually adopted something.
      const gitRoots = this.deps.gitRoots()
      const rootsLine = gitRoots.length === 0
        ? ''
        : `Memory git roots (for the Pre-Sync step): ${gitRoots.join(', ')}\n`
      const launchText = `${plan.prompt}\n---\n\n# Work plan for this run\n\n${plan.plan}\n\nVaults, budgets, and cluster detail above are authoritative; verify each candidate with memory_read before acting.\n${rootsLine}`
      const route = this.launchRoute(model)
      if (route === null) {
        // startRun's blockedReason already gates this; the host default
        // route is live, so re-check it at the moment of launch.
        throw new DreamBlockedError(NO_AGENT_MODEL_ROUTE)
      }
      const handle = await gateway.create({
        sessionId: `${DREAM_SESSION_PREFIX}${id}`,
        agentOptions: route,
        // meta.cwd is durable header data the session boundary validates and
        // snapshots; without it the header has no cwd, the transcript lands
        // in the _no-cwd bucket, and inspectApiSession answers
        // session/not-found for every GUI open (PLAN-dream-meta-cwd). The
        // plugin dbPath is absolute by config contract, one deterministic
        // bucket, no fallback chain.
        meta: { cwd: this.deps.config.milvus.dbPath },
      })
      try {
        handle.agent.followup({ content: [{ type: 'text', text: launchText }], source: { kind: 'user' } })
        await handle.agent.whenIdle()
        // Inside the try, before the seed/stamp/post-pass: a failed turn
        // throws through the existing catch so nothing is recorded as
        // success (TASK-003).
        this.assertNoFailedTurn(id, handle.agent)
      } finally {
        await handle.dispose()
      }
      this.seedDreamsDiary(id)
      // Order load-bearing (ext): score against the PREVIOUS stamp, then
      // stamp lastDreamAt.
      const scoring = this.applyDreamScoring()
      this.setLastDream(Date.now())
      // Memory git commit (TASK-006): one closing pass over every shared
      // vault, after the stamp so plugin state is settled. The manager
      // never rejects and a disabled gate answers []; the catch is the
      // belt against a throwing dep, because the memory work landed and
      // ok stays true.
      let gitOutcomes: VaultGitCommitOutcome[] = []
      try {
        gitOutcomes = await this.deps.commitMemory(`obsidian-mem: dream ${String(new Date().toISOString())}`)
      } catch (error: unknown) {
        this.deps.log(`dream ${id}: memory git commit failed: ${describeError(error)}`)
      }
      // Budget rebaseline (PLAN-budget-rebaseline TASK-002): the ok path
      // zeroes the live per-session recall counters through the wired dep,
      // so the global budget window starts at this run. Failed paths never
      // reach here, so a dead agent never reopens the gate.
      this.deps.onRunSucceeded?.()
      this.deps.log(`dream ${id} done: ${String(scoring.bumped)} bumped, ${String(scoring.degraded)} degraded, ${String(scoring.archiveCandidates.length)} archive candidates`)
      return finish(true, null, scoring, gitOutcomes)
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
      lines.push(`${next()} Global memory is over budget (${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used, injected since the last successful dream or host restart), and every live global note is a vault global file the dreaming pass never compacts: compaction cannot help; with the user's approval, manually tighten ${input.budget.globalNotePaths.join(', ')} to reclaim budget.`)
    } else {
      lines.push(`${next()} Global memory is over budget (${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used, injected since the last successful dream or host restart). ${String(input.budget.globalNoteCount)} live global notes inject; as the lighter remedy, compact just these notes, least-read first: ${input.budget.compactableGlobalNotePaths.join(', ')}; ${MANUAL_COMPACTION_RECIPE}; ${MANUAL_COMPACTION_APPROVAL}. ${DREAM_RUN_SUGGESTION}`)
    }
  } else {
    lines.push(`${next()} Global budget headroom: ${String(input.budget.usedTokens)} of ${String(input.budget.budgetTokens)} tokens used, injected since the last successful dream or host restart, ${String(input.budget.globalNoteCount)} live global notes.`)
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
    .replaceAll('{{CHURN_THRESHOLD_PERCENT}}', String(config.git.churnThresholdPercent))
    .replaceAll('{{CHURN_WINDOW_COMMITS}}', String(config.git.churnWindowCommits))
}
