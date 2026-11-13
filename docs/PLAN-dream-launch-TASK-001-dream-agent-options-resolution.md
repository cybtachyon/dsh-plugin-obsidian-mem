# TASK-001: dream-agent-options-resolution

Resolve the dream agent's `AgentOptions` in `DreamOrchestrator` and pass them
to `agents.create`, so a launched dream agent always has a provider/model
pair and the persona `{{model}}` interpolation can never see an undefined
value.

## Files

- `packages/service/src/dream.ts`
- `packages/service/tests/dream.spec.ts`

## Changes

1. `DreamDeps`: add
   `defaultAgentOptions: () => { provider?: string, model?: string } | undefined`
   — "Host default provider/model route for spawned agents; undefined when
   the host offers no default-model service."
2. Add one private resolver, e.g. `private agentLaunchOptions(modelOverride?: string): { sessionId: string, agentOptions?: { provider?: string, model?: string } }`-shaped
   assembly (name it for what it decides; keep it the single home for the
   precedence rule):
   - `host = this.deps.defaultAgentOptions() ?? {}`
   - `model = firstNonEmpty(modelOverride, this.deps.config.dreaming.model, host.model)`
     (empty string counts as unset; `config.dreaming.model` is finally
     consumed, replacing the stale `DreamRequest.model` comment claim).
   - `provider = host.provider` (only source; model overrides never change
     the provider route). Document that in the option comment.
3. `blockedReason()`: keep the existing no-gateway message; add a second
   reason when `provider === undefined || model === undefined`:
   "no provider/model can be resolved for the dream agent (mount the host
   agentDefaultModel service or set dreaming.model)". The card already
   renders `blocked` and disables Run on it.
4. `startRun` / `drive`: launch via the resolver. `agentOptions` always
   carries both resolved values when present. The per-run `options.model`
   override flows into the resolver as `modelOverride`.
5. Update the stale doc comments (`DreamRequest.model`, the class header
   §2.6 sentence) to name the precedence and the provider rule.

## Tests (dream.spec.ts)

- Double gains `defaultAgentOptions` (default `{ provider: 'acme', model: 'm-1' }`).
- Assert the launched create payload: `{ sessionId: /^dream-/, agentOptions: { provider: 'acme', model: 'm-1' } }`
  for the plain run (replaces the current no-agentOptions expectation).
- Precedence: per-run override wins over config; config wins over host; host
  used when both empty; `config.dreaming.model = ''` behaves unset.
- `blockedReason()` names the provider/model reason when
  `defaultAgentOptions` returns `undefined` and no override/config exists.

## Definition of Done

- `pnpm vitest run packages/service/tests/dream.spec.ts` green; new
  precedence and blocked tests present; lint clean on touched files; commit
  (message names the model-resolution fix, no attribution words).
