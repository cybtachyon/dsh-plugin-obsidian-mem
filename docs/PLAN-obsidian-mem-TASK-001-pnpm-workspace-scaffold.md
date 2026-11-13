# TASK-001 pnpm workspace scaffold

Status: done

Depends: none. Study `/home/derek/src/dsh-plugin-local-infer` first (root package.json,
tsconfig.base.json, eslint.config.mjs, vitest.config.ts, scripts/build-client.mjs,
scripts/build-format.mjs, scripts/verify-emit.mjs, pnpm-workspace.yaml). Copy and adapt.

## Scope

- `packages/{core,service,ui,tools,events,client,bundle}` with per-package package.json +
  tsconfig.json; cross-package imports by relative path (`../../core/lib/index.js`), never
  self-referencing bare specifiers.
- Root `package.json` is the installable bundle: name `dsh-plugin-obsidian-mem`, type module,
  `dsh.bundle.patch: "./cordis.patch.yml"`, `dsh.client: { platform: "web", immediately: true,
  inject: [] }`, exports map for `.`, `./client`, `./core`, `./service`, `./ui`, `./tools`,
  `./events`, `./locale/*.json`, `./icon`, `./package.json`; peerDependencies
  `@deepseek-ai/cordis`; runtime dependencies: `@huggingface/transformers`,
  `@zilliz/milvus2-sdk-node`, `gray-matter` (frontmatter). devDependencies mirror local-infer
  (typescript, vitest, @vitest/coverage-v8, esbuild, eslint + typescript-eslint, tsx,
  @types/node, yaml). `files` lists shipped artifacts (dsh/*.js, packages/*/lib, locales,
  icon, cordis.patch.yml). engines node ^22.19 || >=24.
- `packages/bundle` is the private meta-package with the duplicate cordis.patch.yml and
  workspace deps on service/ui/tools/events (mirrors local-infer layout).
- Scripts: build (tsc -b --force, node scripts/build-client.mjs, build-format.mjs,
  verify-emit.mjs), typecheck, test (vitest run), test:coverage, lint, clean.
- tsconfig.base.json (NodeNext module/resolution, strict, declaration, sourcemaps, composite),
  per-package project references; eslint flat config adapted from local-infer; vitest config
  adapted (jsdom not needed for host code; keep node env, coverage thresholds may start lower
  and TASK-060 raises them).
- `.gitignore` (node_modules, lib build outputs EXCEPT keep local-infer policy: lib is tracked
  there; here keep `lib/` untracked for simplicity, coverage/, dsh/.build/).
- mise.toml already pins pnpm+prek; keep.

## DoD

`pnpm install` succeeds; workspace links resolve; root package.json validates against the
local-infer shape; commit.
