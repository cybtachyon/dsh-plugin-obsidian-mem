import { describe, expect, it } from 'vitest'
import { manifestQueryText, scanManifest } from '../src/manifest.ts'
import type { ManifestDirEntry, ManifestFs } from '../src/manifest.ts'

/**
 * Workspace manifest spec for TASK-014: marker-file detection for a
 * ts+react repo, a go repo, and a polyglot tree; skip-directory and
 * depth-bound rules for the walk; extension counting and directory
 * signals; and the stable, sorted manifestQueryText rendering.
 */

/** In-memory posix path tree: keys are file paths, values their content. */
function virtualFs(tree: Readonly<Record<string, string>>): ManifestFs {
  const files = new Map(Object.entries(tree))
  const dirs = new Map<string, Map<string, boolean>>()
  const register = (dir: string, name: string, directory: boolean): void => {
    const listing = dirs.get(dir) ?? new Map<string, boolean>()
    listing.set(name, directory)
    dirs.set(dir, listing)
  }
  for (const filePath of files.keys()) {
    const parts = filePath.split('/').filter((part) => part !== '')
    for (let index = 0; index < parts.length; index += 1) {
      const parent = `/${parts.slice(0, index).join('/')}`.replace(/\/$/, '') || '/'
      register(parent === '' ? '/' : parent, parts[index] as string, index < parts.length - 1)
    }
  }
  return {
    listDirectory(path: string): ManifestDirEntry[] | null {
      const listing = dirs.get(path)
      if (listing === undefined) {
        return null
      }
      return [...listing.entries()].map(([name, directory]) => ({ name, directory }))
    },
    readFile(path: string): string | null {
      return files.get(path) ?? null
    },
  }
}

const TS_REACT_TREE: Readonly<Record<string, string>> = {
  '/repo/package.json': JSON.stringify({
    dependencies: { react: '^19.0.0', next: '^15.0.0' },
    devDependencies: { vite: '^6.0.0' },
  }),
  '/repo/tsconfig.json': '{}',
  '/repo/src/App.tsx': 'export const App = 1',
  '/repo/src/util.ts': 'export const x = 1',
  '/repo/README.md': '# repo',
  '/repo/Makefile': 'all:\n\techo hi\n',
  '/repo/.cache/package.json': JSON.stringify({ dependencies: { vue: '^3' } }),
}

describe('scanManifest: ecosystem detection', () => {
  it('detects a ts+react repo with frameworks, build system, and signals', () => {
    expect(scanManifest('/repo', virtualFs(TS_REACT_TREE))).toEqual({
      cwd: '/repo',
      languages: ['javascript', 'typescript'],
      frameworks: ['next', 'react', 'vite'],
      buildSystems: ['make'],
      dependencyFiles: ['Makefile', 'package.json', 'tsconfig.json'],
      topExtensions: ['json', 'md', 'ts', 'tsx'],
      dirSignals: ['src/'],
    })
  })

  it('detects a go repo from go.mod with cmd/ and internal/ signals', () => {
    const manifest = scanManifest('/goapp', virtualFs({
      '/goapp/go.mod': 'module example.com/goapp\n\ngo 1.23\n',
      '/goapp/cmd/server/main.go': 'package main\n',
      '/goapp/internal/db/db.go': 'package db\n',
    }))
    expect(manifest.languages).toEqual(['go'])
    expect(manifest.dependencyFiles).toEqual(['go.mod'])
    expect(manifest.dirSignals).toEqual(['cmd/', 'internal/'])
    expect(manifest.topExtensions[0]).toBe('go')
  })

  it('detects a polyglot tree across ecosystems', () => {
    const manifest = scanManifest('/mix', virtualFs({
      '/mix/package.json': JSON.stringify({ dependencies: { react: '^19' } }),
      '/mix/go.mod': 'module mix\n',
      '/mix/requirements-api.txt': 'django==5.0\n',
      '/mix/Gemfile': "source 'https://rubygems.org'\ngem 'rails'\n",
      '/mix/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.28)\n',
      '/mix/mix.exs': 'defmodule Mix.MixProject do\nend\n',
      '/mix/src/Main.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
      '/mix/tests/test_app.py': 'assert True\n',
      '/mix/packages/sub/pyproject.toml': '[project]\nname = "sub"\n',
    }))
    expect(manifest.languages).toEqual([
      'cpp', 'csharp', 'elixir', 'go', 'javascript', 'python', 'ruby',
    ])
    expect(manifest.frameworks).toEqual(['django', 'rails', 'react'])
    expect(manifest.dirSignals).toEqual(['packages/', 'src/', 'tests/'])
    expect(manifest.dependencyFiles).toEqual([
      'CMakeLists.txt', 'Gemfile', 'go.mod', 'mix.exs', 'package.json',
      'packages/sub/pyproject.toml', 'requirements-api.txt', 'src/Main.csproj',
    ])
  })

  it('detects rust, php, java, and kotlin from their manifests', () => {
    const manifest = scanManifest('/poly', virtualFs({
      '/poly/Cargo.toml': '[package]\nname = "poly"\n',
      '/poly/composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
      '/poly/pom.xml': '<project><dependency>org.jetbrains.kotlin:kotlin-stdlib</dependency></project>',
      '/poly/app/build.gradle.kts': 'plugins { kotlin("jvm") version "2.0.0" }\n',
    }))
    expect(manifest.languages).toEqual(['java', 'kotlin', 'php', 'rust'])
    expect(manifest.frameworks).toEqual(['laravel'])
  })

  it('keeps a malformed package.json as a dependency file without frameworks', () => {
    const manifest = scanManifest('/bad', virtualFs({
      '/bad/package.json': 'not json at all {{{',
    }))
    expect(manifest.dependencyFiles).toEqual(['package.json'])
    expect(manifest.languages).toEqual(['javascript'])
    expect(manifest.frameworks).toEqual([])
  })

  it('tolerates unreadable directories', () => {
    const fs = virtualFs({
      '/repo/package.json': '{}',
      '/repo/src/pyproject.toml': '[project]\nname = "x"\n',
    })
    const broken: ManifestFs = {
      listDirectory(path: string) {
        return path === '/repo/src' ? null : fs.listDirectory(path)
      },
      readFile: (path) => fs.readFile(path),
    }
    // The unreadable src/ subtree contributes nothing; the scan keeps
    // going with what it can read.
    const manifest = scanManifest('/repo', broken)
    expect(manifest.dependencyFiles).toEqual(['package.json'])
    expect(manifest.languages).toEqual(['javascript'])
  })
})

describe('scanManifest: walk bounds', () => {
  it('ignores manifests inside node_modules and other skip directories', () => {
    const manifest = scanManifest('/app', virtualFs({
      '/app/package.json': JSON.stringify({ dependencies: { react: '^19' } }),
      '/app/node_modules/left-pad/package.json': JSON.stringify({ dependencies: { vue: '^3' } }),
      '/app/vendor/pkg/composer.json': '{"require":{"symfony/console":"^7"}}',
      '/app/dist/build/package.json': '{"dependencies":{"svelte":"^5"}}',
      '/app/.git/package.json': '{}',
      '/app/venv/lib/Pipfile': '[packages]\ndjango = "*"\n',
    }))
    expect(manifest.dependencyFiles).toEqual(['package.json'])
    expect(manifest.frameworks).toEqual(['react'])
  })

  it('scans files up to three path segments deep, no deeper', () => {
    const manifest = scanManifest('/deep', virtualFs({
      '/deep/a/package.json': '{}',
      '/deep/a/b/go.mod': 'module b\n',
      '/deep/a/b/c/Cargo.toml': '[package]\nname = "c"\n',
      '/deep/a/b/c/d/pom.xml': '<project/>',
    }))
    expect(manifest.dependencyFiles).toEqual(['a/b/go.mod', 'a/package.json'])
  })

  it('counts file extensions with count DESC then alpha, capped at 8', () => {
    const tree: Record<string, string> = { '/repo/a.ts': '', '/repo/b.ts': '', '/repo/c.md': '' }
    for (const ext of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']) {
      tree[`/repo/f-${ext}.${ext}`] = ''
    }
    const manifest = scanManifest('/repo', virtualFs(tree))
    expect(manifest.topExtensions).toEqual(['ts', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
  })

  it('treats leading-dot files as extensionless', () => {
    const manifest = scanManifest('/d', virtualFs({ '/d/.env': 'X=1' }))
    expect(manifest.topExtensions).toEqual([])
  })

  it('returns an empty manifest for an unreadable root', () => {
    const empty: ManifestFs = { listDirectory: () => null, readFile: () => null }
    expect(scanManifest('/gone', empty)).toEqual({
      cwd: '/gone',
      languages: [],
      frameworks: [],
      buildSystems: [],
      dependencyFiles: [],
      topExtensions: [],
      dirSignals: [],
    })
  })
})

describe('manifestQueryText', () => {
  it('renders fixed key order with sorted lists', () => {
    const text = manifestQueryText(scanManifest('/repo', virtualFs(TS_REACT_TREE)))
    expect(text).toBe([
      'cwd: /repo',
      'languages: javascript, typescript',
      'frameworks: next, react, vite',
      'build systems: make',
      'dependency files: Makefile, package.json, tsconfig.json',
      'top extensions: json, md, ts, tsx',
      'directory signals: src/',
    ].join('\n'))
  })

  it('is byte-stable across repeated scans of the same tree', () => {
    const first = manifestQueryText(scanManifest('/repo', virtualFs(TS_REACT_TREE)))
    const second = manifestQueryText(scanManifest('/repo', virtualFs(TS_REACT_TREE)))
    expect(second).toBe(first)
  })

  it('renders empty lists as empty values, keeping every line', () => {
    const empty: ManifestFs = { listDirectory: () => null, readFile: () => null }
    expect(manifestQueryText(scanManifest('/x', empty)).split('\n')).toHaveLength(7)
  })
})
