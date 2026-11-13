# TASK-014 Workspace manifest scanner

Status: done

Depends: TASK-010. `packages/core/src/manifest.ts`.

## Scope

- `WorkspaceManifest = { cwd, languages[], frameworks[], buildSystems[], dependencyFiles[],
  topExtensions[], dirSignals[] }` plus `manifestQueryText()` (compact string for embedding
  alongside the user prompt at turn start).
- Marker scan rules: walk cwd bounded (depth <= 3, skip `node_modules, vendor, dist, build,
  target, .git, venv, .venv, __pycache__, .next, .venv, coverage, .cache`); detect only from
  dependency/manifest FILES: package.json (+ deps names → frameworks react/vue/svelte/next/
  vite/nest etc.), tsconfig.json→typescript, go.mod/go.work→go, Cargo.toml→rust,
  requirements*.txt/pyproject.toml/setup.py/Pipfile→python (+django/flask/fastapi deps),
  composer.json→php (+laravel/symfony/doctrine), Gemfile→ruby (+rails), pom.xml/build.gradle
  (.kts)→java/kotlin, CMakeLists.txt→cpp, mix.exs→elixir, deno.json, *.csproj→csharp,
  Makefile/justfile/mise.toml/Taskfile.yml→build systems.
- `dirSignals`: e.g. `src/`, `app/`, `packages/`, `cmd/`, `internal/`, `migrations/`,
  `tests/`; `topExtensions`: top 8 file extensions by count.
- Pure `scanManifest(cwd, fsLike)` with injectable fs for tests.

## DoD

Fixture-tree tests (ts+react repo, go repo, polyglot), skip rules verified (a package.json
inside node_modules ignored); queryText format stable/sorted; commit.
