/**
 * Stale-lib-artifact guard tests (TASK-014): every file carrying a tsc
 * emitted extension under a package lib must have a src sibling, so a
 * git rm'd source can never leave tracked lib files shipping forever
 * (the events/lib/budget.* leftover TASK-010 had to remove by hand).
 * Pins scripts/verify-emit.mjs staleLibArtifacts: green on the built
 * tree, plus temp-tree orphan, tsx-sibling, nested-dir, non-emitted,
 * missing-src, and no-tsconfig cases. Run after `pnpm build` (same lib
 * assumption as the repo's other lib-consuming suites).
 * @module dsh-plugin-obsidian-mem/tools/tests/stale-lib-artifacts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { staleLibArtifacts } from '../../../scripts/verify-emit.mjs'

const repoRoot = process.cwd()

/** All four emitted siblings one source stem produces. */
const EMITTED = ['js', 'js.map', 'd.ts', 'd.ts.map']

/**
 * makePkg writes a minimal package (tsconfig plus chosen src and lib
 * files) into a temp tree rootDir, so mutations exercise
 * staleLibArtifacts without touching the repo.
 */
function makePkg(
  rootDir: string,
  name: string,
  sources: string[],
  libFiles: string[],
  withTsConfig = true,
): void {
  const pkg = join(rootDir, 'packages', name)
  mkdirSync(join(pkg, 'src'), { recursive: true })
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  if (withTsConfig) {
    writeFileSync(join(pkg, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'lib' },
    }))
  }
  for (const source of sources) {
    const sourcePath = join(pkg, 'src', source)
    mkdirSync(join(sourcePath, '..'), { recursive: true })
    writeFileSync(sourcePath, 'export const x = 1\n')
  }
  for (const file of libFiles) {
    writeFileSync(join(pkg, 'lib', file), 'export const x = 1\n')
  }
}

/**
 * inTemp runs body over a fresh temp tree and returns its result,
 * removing the tree afterwards.
 */
function inTemp<T>(body: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(join(tmpdir(), 'stale-lib-'))
  try {
    return body(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

/** emittedFor lists the four lib names one stem emits, under a prefix. */
function emittedFor(stem: string): string[] {
  return EMITTED.map((ext) => `${stem}.${ext}`)
}

describe('stale lib artifact guard (verify-emit)', () => {
  it('reports no stale artifacts on the built tree', () => {
    expect(staleLibArtifacts(repoRoot)).toEqual([])
  })

  it('names exactly the emitted lib files whose source sibling is gone', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'fake',
        ['foo.ts'],
        [...emittedFor('foo'), ...emittedFor('gone')])
      expect(staleLibArtifacts(rootDir).sort()).toEqual(
        emittedFor('gone')
          .map((f) => `packages/fake/lib/${f}: no "${f.replace(/\.(js\.map|d\.ts\.map|js|d\.ts)$/, '')}.ts(x)" source sibling`)
          .sort(),
      )
    })
  })

  it('accepts a .tsx source as the sibling of its emits', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'fake', ['card.tsx'], emittedFor('card'))
      expect(staleLibArtifacts(rootDir)).toEqual([])
    })
  })

  it('resolves nested lib subdirs against the src tree', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'fake', ['milvus/client.ts'], [])
      mkdirSync(join(rootDir, 'packages/fake/lib/milvus'), { recursive: true })
      for (const name of emittedFor('milvus/client')) {
        writeFileSync(join(rootDir, 'packages/fake/lib', name), 'export const x = 1\n')
      }
      expect(staleLibArtifacts(rootDir)).toEqual([])
      writeFileSync(join(rootDir, 'packages/fake/lib/milvus/orphan.js'), 'export const y = 1\n')
      const stale = staleLibArtifacts(rootDir)
      expect(stale).toHaveLength(1)
      expect(stale[0]).toContain('packages/fake/lib/milvus/orphan.js')
    })
  })

  it('ignores lib files that carry no emitted extension', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'fake', [], ['README.txt', 'data.json'])
      expect(staleLibArtifacts(rootDir)).toEqual([])
    })
  })

  it('names every emit when the package src tree is gone', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'fake', [], emittedFor('kept'))
      rmSync(join(rootDir, 'packages/fake/src'), { recursive: true, force: true })
      expect(staleLibArtifacts(rootDir)).toHaveLength(EMITTED.length)
    })
  })

  it('skips package dirs without a tsconfig and packages without a lib', () => {
    inTemp((rootDir) => {
      makePkg(rootDir, 'bundle-meta', [], emittedFor('stray'), false)
      makePkg(rootDir, 'no-lib', ['only.ts'], [])
      rmSync(join(rootDir, 'packages/no-lib/lib'), { recursive: true, force: true })
      expect(staleLibArtifacts(rootDir)).toEqual([])
    })
  })
})
