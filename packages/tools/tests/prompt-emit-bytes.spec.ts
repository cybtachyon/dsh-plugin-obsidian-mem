/**
 * Prompt-carrier byte-fidelity tests (TASK-015): the lib .js copies of the
 * prepared prompt constants must hold the src constant's exact UTF-8 bytes,
 * because loadPrompt() seeds <dbDir>/dream-prompt.md from the lib constant
 * and the trailing spaces inside those literals are load-bearing. Pins the
 * scripts/verify-emit.mjs check (green tree, stripped-byte failing case,
 * missing declaration), and pins that the three lists naming the six
 * carriers (prek.toml, scripts/build-format.mjs, scripts/verify-emit.mjs)
 * stay the same set. Run after `pnpm build` (same lib assumption as the
 * repo's other lib-consuming suites).
 * @module dsh-plugin-obsidian-mem/tools/tests/prompt-emit-bytes
 */

import {
  copyFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PREPARED_PROMPT_CARRIERS } from '../../../scripts/build-format.mjs'
import {
  PROMPT_BYTE_CARRIERS, promptConstantDrifts,
} from '../../../scripts/verify-emit.mjs'

const repoRoot = process.cwd()

/** Every src/lib carrier file path the byte pin covers (the six). */
const carrierPaths: string[] = PROMPT_BYTE_CARRIERS.flatMap(({ src, lib }) => [src, lib])

/**
 * copyCarriers copies the six carrier files into a temp tree rootDir, so a
 * mutation there exercises promptConstantDrifts without touching the repo.
 */
function copyCarriers(rootDir: string): void {
  for (const carrier of carrierPaths) {
    const target = join(rootDir, carrier)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(repoRoot, carrier), target)
  }
}

/**
 * inTempCarriers runs body over a fresh temp copy of the six carriers and
 * returns its result, removing the temp tree afterwards.
 */
function inTempCarriers<T>(body: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(join(tmpdir(), 'prompt-emit-bytes-'))
  try {
    copyCarriers(rootDir)
    return body(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

/** stripTrailing applies build-format.mjs's per-line strip to one file. */
function stripTrailing(file: string): void {
  const content = readFileSync(file, 'utf8')
  writeFileSync(file, content
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n'))
}

describe('prepared prompt carrier byte fidelity (verify-emit)', () => {
  it('reports no drift on the built tree', () => {
    expect(promptConstantDrifts(repoRoot)).toEqual([])
  })

  it('names every carrier whose lib constant lost a trailing space', () => {
    inTempCarriers((rootDir) => {
      const changed: string[] = []
      for (const { lib } of PROMPT_BYTE_CARRIERS) {
        const target = join(rootDir, lib)
        const before = readFileSync(target, 'utf8')
        stripTrailing(target)
        if (readFileSync(target, 'utf8') !== before) {
          changed.push(lib)
        }
      }
      // The strip no-ops on a prompt with no trailing spaces; whatever it
      // did change must surface as exactly one drift naming that carrier.
      const drifts = promptConstantDrifts(rootDir)
      expect(drifts).toHaveLength(changed.length)
      for (const lib of changed) {
        expect(drifts.some((drift) => drift.startsWith(`${lib}:`))).toBe(true)
      }
      expect(changed.length).toBeGreaterThan(0)
    })
  })

  it('names each carrier whose lib constant gained or lost one byte', () => {
    for (const { lib, constant } of PROMPT_BYTE_CARRIERS) {
      inTempCarriers((rootDir) => {
        const target = join(rootDir, lib)
        const content = readFileSync(target, 'utf8')
        const marker = `export const ${constant} = \``
        const insert = content.indexOf(marker) + marker.length
        writeFileSync(target, `${content.slice(0, insert)}X${content.slice(insert)}`)
        const drifts = promptConstantDrifts(rootDir)
        expect(drifts).toHaveLength(1)
        expect(drifts[0]).toContain(lib)
        expect(drifts[0]).toContain(constant)
      })
    }
  })

  it('names a carrier whose lib declaration disappeared', () => {
    inTempCarriers((rootDir) => {
      writeFileSync(join(rootDir, 'packages/service/lib/dream.js'), 'export const OTHER = 1\n')
      const drifts = promptConstantDrifts(rootDir)
      expect(drifts).toHaveLength(1)
      expect(drifts[0]).toContain('DEFAULT_DREAM_PROMPT')
      expect(drifts[0]).toContain('declaration not found')
    })
  })

  it('reads as byte-exact once the stripped bytes are restored', () => {
    inTempCarriers((rootDir) => {
      const strippedLib = join(rootDir, 'packages/tools/lib/audit.js')
      stripTrailing(strippedLib)
      expect(promptConstantDrifts(rootDir)).toHaveLength(1)
      copyFileSync(join(repoRoot, 'packages/tools/lib/audit.js'), strippedLib)
      expect(promptConstantDrifts(rootDir)).toEqual([])
    })
  })
})

describe('six-carrier set coherence across prek.toml and the two scripts', () => {
  it('matches prek.toml trailing-whitespace exclusions exactly', () => {
    const toml = readFileSync(join(repoRoot, 'prek.toml'), 'utf8')
    const raw = toml.match(/id = "trailing-whitespace", exclude = "([^"]+)"/)?.[1]
    expect(raw).toBeTypeOf('string')
    // TOML basic strings eat one backslash layer; the regex text carries single ones.
    const pattern = new RegExp((raw as string).replace(/\\\\/g, '\\'))
    for (const carrier of [...PREPARED_PROMPT_CARRIERS].sort()) {
      expect(pattern.test(carrier)).toBe(true)
    }
    expect(pattern.test('packages/service/lib/dream.d.ts')).toBe(false)
    expect(pattern.test('packages/tools/lib/audit.js.map')).toBe(false)
    expect(pattern.test('packages/service/src/service.ts')).toBe(false)
  })

  it('keeps the build-format skip-list and the verify-emit carrier pairs the same six paths', () => {
    expect([...carrierPaths].sort()).toEqual([...PREPARED_PROMPT_CARRIERS].sort())
  })

  it('names the three prepared prompt constants once each', () => {
    expect(PROMPT_BYTE_CARRIERS.map(({ constant }) => constant).sort()).toEqual([
      'AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT',
      'DEFAULT_DREAM_PROMPT',
      'MEMORY_PROMPT_SECTION_TEXT',
    ])
  })
})
