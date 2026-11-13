# Technical Overview

- This is a DeepSeek Harness (Cordis) plugin that turns Markdown vaults into
  shared agent memory. User-facing behavior (install, use, vaults, backends) is
  documented in [README.md](README.md); this file covers how the code is built
  and verified.

# Architecture

- PNPM Workspace: `packages/{core,service,ui,tools,events,client,bundle}`.
  - `./package.json` is the installable bundle
  - Packages mounted with (`dsh.bundle.patch` → `cordis.patch.yml`).
- **core** is the pure, framework-free domain model:
  - Constants and intent strings shared by every layer
  - `VaultConfig` (path, `shared` | `readonly` mode) and the vault registry model
  - The memory-note Markdown format: frontmatter (`gray-matter`) and body
  - The Markdown chunker (heading-aware split), workspace manifest reading,
    chunk-id hashing
  - Deterministic wake_keywords / trigger_extensions / trigger_frameworks
    extraction (heuristic; the optional LLM pass lives in service)
- **service** is the `ctx.obsidianMem` Cordis service:
  - `ensureMemoryAccess()`: the idempotent lazy-provisioning seam. The first
    tool call or lifecycle hook that touches memory provisions the default
    vault, `.INTENTS.md`, the Milvus dbDir, the collection, and the indexer,
    and returns a one-time `notice` string naming the vault path. Activation
    itself stays side-effect free.
  - Vault registry, embedder (transformers.js, e5-small int8, `passage:` /
    `query:` prefixes, `vectorDim` knob), Milvus-Lite lifecycle (uv/uvx
    auto-spawn, localhost port), indexer manager, hybrid search, and the
    audit/dream compaction engine.
- **ui** carries the host web routes (`/obsidian-mem/*`) behind the settings
  card: vault registry CRUD, index state, audit/dream state.
- **tools** registers the five model-facing tools:
  - `memory_read`, `memory_search`, `memory_write`, `memory_dream`,
    `memory_audit`, plus the system-prompt section that tells the agent when
    to reach for them.
- **events** carries the lifecycle hooks: turn-start recall injection, the
  Read-tool intercept, the Think-stream keyword intercept, the turn-end
  save/audit reminder, and the global per-session recall budget.
- **client** is the browser card source:
  - `packages/client` is the source private workspace package
  - ESBuild bundles to lazy-CJS artifact `dsh/client.js`
    (scaffold note: until the card lands in TASK-051/052,
    `scripts/build-client.mjs` skips and no `dsh/client.js` exists).
  - **bundle** is the meta-package holding the duplicate `cordis.patch.yml`
    and the workspace deps, wiring service/ui/tools/events into one layer.
- **client build pipeline** `pnpm build`:
  - Runs `tsc -b --force` (type-checks and always re-emits every project's
    `lib`, so stale tsbuildinfo state or emptied outputs cannot survive it).
  - Then `node scripts/build-client.mjs` esbuild-bundles the client entry to
    (`dsh/.build/client.cjs`) and wraps it in
    `window.__ModuleLoader__.load({ id, factory: (require) => ... })` contract
    to write `dsh/client.js`.
  - Then `node scripts/build-format.mjs` normalizes the trailing newlines of
    the emitted lib artifacts (`.js`, `.d.ts`, `.js.map`, and `.d.ts.map` in
    `dsh` and every `packages/*/lib`) so the build leaves the tree clean.
  - Then `node scripts/verify-emit.mjs` fails the build when any expected
    `lib` artifact, `dsh/host.js`, or (once the card marker
    `packages/client/src/card.ts[x]` exists) `dsh/client.js` is missing or
    emptied.
  - `react` and `@deepseek-ai/dsh-client-ui-primitives` are esbuild externals:
    they stay out of the bundle and resolve at runtime through the DSH's
    frozen platform module table with `require` calls.
  - The client TypeScript source is not shipped; the root `files` list
    ships only `dsh/client.js` and `dsh/host.js` from the client half.

# Dev Environment Tips

- There is no `codegraph` tool here. Query the codebase with `grep` and file
  reads; prefer existing API and programming patterns over new code.
- When implementing, do not rely on memory. Look up the tool's documentation
  for the current version, or use online resources, to ensure accuracy.
- DeepSeek Harness supports a Creator Mode for deep introspection. If not
  active, request the user to set it for the next turn.
- Use Vitest tests to answer questions, verify code, and test functionality.
- Sub-packages import each other by relative path
  (`../../core/lib/index.js`). A self-referencing bare specifier
  (`dsh-plugin-obsidian-mem/core`) only resolves when the package has a
  self-link inside a `node_modules` tree, so it fails on local/pnpm installs.
- **lib is NOT tracked here.** Unlike dsh-plugin-local-infer (which commits
  `packages/*/lib` so a git install ships entry points), this repo git-ignores
  `packages/*/lib` and `packages/*/tsconfig.tsbuildinfo`: a `pnpm build`
  regenerates them, and plugin installs go through plugin_manager from a built
  tree. After `git clean`, run `pnpm build` before anything consumes `lib/`.
- A bundle with a client half needs a bare-package carrier row: a no-op
  `dsh/host.js` module, a root `.` export, and a bundle row named after the
  bare package. The client-module scan keys `dsh.client` on a bare
  package-root entry, never a subpath, so without it the browser card is
  never loaded.
- Client-side and host-side changes activate differently. A page refresh picks
  up a new `dsh/client.js`, but host-side packages (service, ui, tools,
  events) load into the host process at startup: a bundle reinstall rewrites
  `~/.dsh/profiles/<profile>/node_modules`, and the running host keeps its
  in-memory modules until a restart or a bundle toggle off/on. Verify a
  host-side change by restarting the host, not by reloading the page.

# DSH Event Facts (verified against the live cordis 4.x Event catalog
# + the events engramory-ext actually registers; see
# docs/research/engramory-and-ext-findings.md §2.2)

- There is **no `turn/start` or `turn/end`** event on the agent bus;
  `turn/end` exists only as a *session-log* event type under `session/event`.
- Turn-start recall rides `agent/pre-step` (waterfall: a listener that does not
  own the decision MUST return `next()`, spreading the decision object).
- The turn-end save/audit reminder rides `agent/turn-stopping` (serial) and
  delivers via `agent.steer(...)`; the steer keeps the turn open, so a
  once-per-turn guard is mandatory or the turn loops forever.
- Agent-scoped events (`this: Scoped<Agent>`: `agent/pre-step`,
  `agent/assistant-stream`, `agent/turn-stopping`) fire on the AGENT's own
  context: register from an `agent/created` handler on `agent.ctx` (wrap in
  `agent.ctx.effect()` and keep the disposer in the plugin's own effect).
  Plugin-ctx listeners for these never fire (dsh-longterm-memory lesson).
- `agent.inject()` adds per-agent context without waking the agent (lands in
  the next admitted step); `agent.followup()` wakes it; `agent.steer()` keeps
  an open turn open.
- `agent/request` cannot change request messages; it replaces the frozen call
  configuration only.
- Tool observation rides `tools/result` (emit, final outcome);
  `tools/post-execute` only to transform a result; refusal is
  `ctx.tools.guard()` (synchronous, monotonic) or `ask` from
  `tools/pre-execute`.
- Tool registration is `scope.tools.register({name, description, parameters,
  output:{schema, render}, timeoutMs, execute, presentCall})` via the tools
  seam; failures return values (closed `oneOf` by `kind`), not throws.

# DSH UI Component Library

- Use the DSH UI component library, `@deepseek-ai/dsh-client-ui-primitives`,
  wherever a control or renderer is needed. It is the only place a control can
  be shared between plugins (a plugin cannot import another plugin's
  component). Reuse what fits and lift a deliberate visual difference into a
  prop rather than starting a second copy.
- Discovery entry points for an agent:
  - **Component catalog:** the package README's table (the installed
    `node_modules/@deepseek-ai/dsh-client-ui-primitives/README.md`, source at
    `packages/client/ui-primitives/` in the DSH checkout).
  - **Export surface:** the root export `lib/index.js` (types at
    `lib/types/index.d.ts`). That single import is the whole API.
  - **Theme tokens:** components take `--dsw-*` design tokens. Query the
    client `Theme` inspect provider's `listTokens` method for the current
    token names and light/dark override requirements.
  - **Live slot topology:** the client `Slots` inspect provider's
    `listSubTree` method shows where a card can mount.
- In the lazy-CJS card (`dsh/client.js`, the esbuild artifact from
  `packages/client`), React and the primitives come from the shell's frozen
  platform module table: `require('react')` and
  `require('@deepseek-ai/dsh-client-ui-primitives')`. A missing seed is a
  fallback to native controls, not an error, so guard every primitive use
  (`primitives && typeof primitives.Button === 'function'`).

# Code Style

- Follow [TypeScript Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html).
  Be concise, declarative, and factual.
- Use a declarative and explicit coding style. Ensure single sources of truth
  and use language mechanics for deterministic behavior. Use tools like
  Object Literal Unions, Decorators, and Mixins if they fit the problem.
- Organize code with Services like Managers or Event Subscribers to keep code
  DRY and avoid reinventing the wheel.
- Never use grammatical shortcuts like emdash. Use separate sentences; commas
  and semicolons if necessary. Avoid pronouns and adverbs whenever possible.
- **Doc comments** start with the name and state what it does. Structure:
  `// [Name] [verb]s [what]. [Optional: when/why to use it].`
  Put useful information where users make decisions: usually the constructor,
  not methods.
- **Inline comments** are terse. Prefer end-of-line when short enough.
- **Explain why, not what.** The code shows what it does; comments should
  explain reasoning, non-obvious decisions, or edge cases.
- **Wrap comments** at ~80 characters, continuing naturally at word
  boundaries.
- **Naming matters.** Before proposing a name, stop and review existing names
  in the file. Ask: what would someone assume from this name? Does it fit with
  how similar things are named? A good name is accurate on its own and
  consistent in context. Do not use single-letter variable names besides the
  common `i, j, k, n, x, y, z` in loops.
- **Comment content:**
  - Add information beyond what the code shows (not tautologies)
  - State directly: "Returns X" (not "Note that this returns X")
  - Drop filler: "basically", "actually", "really" add nothing

# Docs

Fetch these docs to answer questions about their covered topic.
- [DeepSeek Harness Cordis Framework](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/refs/heads/master/docs/cordis-tutorial/index.md)

# Testing Instructions

- Build with `pnpm build` (runs `tsc -b --force`, then
  `node scripts/build-client.mjs` to produce the `dsh/client.js` card
  artifact (skips until the client card lands), then
  `node scripts/build-format.mjs`, then `node scripts/verify-emit.mjs` which
  fails the build when any expected `lib` artifact is missing or emptied).
- Run the full test suite with `pnpm test` (runs `vitest run`).
- Run coverage with `pnpm test:coverage`; the suite must clear the thresholds
  in `vitest.config.ts` (scaffold-era floors: lines 75 / functions 75 /
  branches 70 / statements 75; TASK-060 raises them to the project bar).
- Lint the whole repo with `pnpm lint` (runs `eslint .`). This is the
  repo-wide lint gate; do not run `npx eslint` on a subset.
- Run `prek run --files <paths>` before committing (verify pre-commit hooks).
  The installed prek takes `--files`, not `--filename`.
- A prek `commit-msg` hook (`scripts/check_commit_msg_attribution.py`)
  rejects commit messages matching the pattern `claude|anthropic`,
  case-insensitive, because this repo's commits carry no external assistant
  attribution. A fresh clone must run `prek install --hook-type commit-msg`
  to get it; `git commit --no-verify` is the documented bypass.
