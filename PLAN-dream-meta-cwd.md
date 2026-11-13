# PLAN: dream-meta-cwd — make dream sessions GUI-addressable

Follow-up to PLAN-dream-launch (landed `6ebb4e7`..`c944e92`). The fixed
run now produces a full trajectory (verified: `dream-abbef3bc-...` has 21
assistant messages, 75 tool calls, clean `turn/end`, stamped
`lastDreamAt` 21:17), but the GUI cannot open or track it:
`dsh-api-session-controller.inspectApiSession` throws
`session/not-found` for any session header without `cwd`, and the plugin
launches `agents.create({ sessionId, agentOptions })` with no
`meta.cwd`. The user chose the plugin database dir
(`config.milvus.dbPath`, `~/.dsh/obsidian-mem-db`) as the owning project.

## Decisions (questionnaire closed)

- `meta.cwd = config.milvus.dbPath` (absolute by config contract; the
  session boundary validates absolute paths). No vault/process-cwd fallback
  chain: one source, deterministic bucket.
- No `agentPreset`, `parentSession`, or `origin` in meta. The dream agent
  stays a root agent; `origin: 'subagent'` would move it into subagent
  routing ownership, which is wrong here.
- dispose-after-run stays: transcripts persist on disk (Nov 8 files prove
  it), and cold history reads work through the persisted header.

## Verification guidelines

- Gates: `pnpm vitest run packages/service`, `pnpm build`, `pnpm lint`,
  `prek run --files`; tracked `packages/service/lib` emit in the same
  commit.
- Live proof (user, after a host restart): click Run; the new `dream-*`
  transcript must land under
  `~/.dsh/sessions/--home-derek-.dsh-obsidian-mem-db--/` (cwd folded), its
  first record carries `"cwd":"/home/derek/.dsh/obsidian-mem-db"`, and the
  GUI session view loads its history instead of `session/not-found`.

## Tasks

### TASK-001 meta-cwd-at-launch

- `packages/service/src/dream.ts`: widen `DreamAgentsGateway.create`
  options with `meta?: { cwd?: string }`; the launch options assembly adds
  `meta: { cwd: this.deps.config.milvus.dbPath }`. First confirm in the
  installed host (`@deepseek-ai/dsh-agent` `CreateAgentOptions`,
  `dsh-agent-loop` `createAgent`) that `options.meta` flows to
  `sessions.create` unchanged; quote the lines in the commit body.
- Update `packages/service/tests/dream-testkit.ts` recorder and every
  create-payload assertion (dream.spec.ts, service.spec.ts) to expect the
  meta; add one explicit test pinning `meta.cwd` equals the configured
  dbPath.
- Definition of done: targeted vitest green, build + lint green,
  `prek run --files` green, plan checked, one commit with the lib emit.
