# TASK-002: default-model-gateway-wiring

Wire the new `defaultAgentOptions` dep in
`ObsidianMemService.dreamEngine()` to the host's default-model service
through the reflection gateway, mirroring the existing
`agentsGateway: () => this.ctx.get('agents')` line and the installed
`dsh-headless` pattern (`ctx.get("agentDefaultModel")` →
`currentSelection(): ModelSelection`).

## Files

- `packages/service/src/service.ts`
- any service-level wiring spec that fakes `ctx.get` for dream tests
  (`packages/service/tests/`, locate the fake context used by
  `service.spec.ts` or equivalent).

## Changes

1. Define a local structural type (in `dream.ts` or `service.ts`, wherever
   the `DreamAgentsGateway` sibling belongs):
   `interface DreamDefaultModelGateway { currentSelection(): { provider: string, model: string } }`.
2. In `dreamEngine()`: 
   `defaultAgentOptions: () => (this.ctx.get('agentDefaultModel') as DreamDefaultModelGateway | undefined)?.currentSelection() ?? undefined`.
   Wrap in try/catch only if the host `ctx.get` throws for unmounted
   services instead of returning undefined — match how `agentsGateway`
   handles it today and keep the two seams symmetrical.

## Tests

- Wiring-level: with the fake ctx answering `agentDefaultModel` with
  `{ currentSelection: () => ({ provider: 'p', model: 'm' }) }`, a dream run
  launch sees those values in `create`'s `agentOptions`.
- With the fake ctx lacking the service, the run falls back per TASK-001
  precedence (config/override) and, absent those, surfaces the blocked
  reason rather than launching.

## Definition of Done

- `pnpm vitest run packages/service` green; no typed import of the host
  package anywhere (`grep "dsh-agent" packages/service/src` stays empty);
  commit.
