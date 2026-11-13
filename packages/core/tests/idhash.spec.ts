import { describe, expect, it } from 'vitest'
import { chunkId, contentHash, headerHash } from '../src/idhash.ts'
import type { ChunkIdParts } from '../src/idhash.ts'

/**
 * Chunk-id and hashing spec for TASK-015: cross-run stability, the
 * 53-bit safe-integer range, a 10k-input collision-free distribution
 * smoke, model/dim swap freshness, order-sensitive canonicalization,
 * and the sha256 hex shapes of contentHash and headerHash.
 */

/** Deterministic PRNG so the distribution smoke is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function baseParts(overrides: Partial<ChunkIdParts> = {}): ChunkIdParts {
  return {
    vault: 'default',
    source_path: 'markdown/typescript-style.md',
    header_hash: '0123456789abcdef',
    part: 0,
    modelId: 'Xenova/multilingual-e5-small',
    vectorDim: 384,
    ...overrides,
  }
}

describe('chunkId', () => {
  it('returns the same id for the same inputs across calls', () => {
    expect(chunkId(baseParts())).toBe(chunkId(baseParts()))
    expect(chunkId(baseParts({ part: 3 }))).toBe(chunkId(baseParts({ part: 3 })))
  })

  it('stays within the positive safe-integer range', () => {
    const random = mulberry32(20261112)
    for (let index = 0; index < 2000; index += 1) {
      const id = chunkId(baseParts({
        part: Math.floor(random() * 10),
        vectorDim: [128, 192, 256, 384][Math.floor(random() * 4)] as number,
      }))
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    }
  })

  it('produces zero collisions over 10k random inputs', () => {
    const random = mulberry32(987654321)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const seen = new Set<number>()
    for (let index = 0; index < 10_000; index += 1) {
      seen.add(chunkId({
        vault: pick(['default', 'work', 'research', 'vault-a']),
        source_path: `markdown/note-${Math.floor(random() * 5000)}.md`,
        header_hash: Math.floor(random() * Number.MAX_SAFE_INTEGER)
          .toString(16)
          .padStart(16, '0'),
        part: Math.floor(random() * 8),
        modelId: pick(['Xenova/multilingual-e5-small', 'Xenova/multilingual-e5-base']),
        vectorDim: pick([128, 192, 256, 320, 384]),
      }))
    }
    expect(seen.size).toBe(10_000)
    for (const id of seen) {
      expect(Number.isSafeInteger(id)).toBe(true)
    }
  })

  it('mints fresh ids when modelId or vectorDim changes (full re-embed on swap)', () => {
    const original = chunkId(baseParts())
    expect(chunkId(baseParts({ modelId: 'Xenova/multilingual-e5-base' }))).not.toBe(original)
    expect(chunkId(baseParts({ vectorDim: 256 }))).not.toBe(original)
  })

  it('changes id when any single part changes', () => {
    const original = chunkId(baseParts())
    const mutated = [
      baseParts({ vault: 'work' }),
      baseParts({ source_path: 'markdown/other.md' }),
      baseParts({ header_hash: 'fedcba9876543210' }),
      baseParts({ part: 1 }),
      baseParts({ modelId: 'other/model' }),
      baseParts({ vectorDim: 192 }),
    ]
    for (const parts of mutated) {
      expect(chunkId(parts)).not.toBe(original)
    }
  })

  it('bakes join order into the id, not the field value multiset', () => {
    // Swapping two fields' values moves them to different join slots;
    // the canonical strings differ, so the ids must differ.
    expect(chunkId(baseParts({
      vault: 'alpha', source_path: 'beta.md',
    }))).not.toBe(chunkId(baseParts({
      vault: 'beta.md', source_path: 'alpha',
    })))
    expect(chunkId(baseParts({
      header_hash: 'aaaa000000000001', modelId: 'bbbb000000000002',
    }))).not.toBe(chunkId(baseParts({
      header_hash: 'bbbb000000000002', modelId: 'aaaa000000000001',
    })))
    expect(chunkId(baseParts({ part: 12, vectorDim: 384 })))
      .not.toBe(chunkId(baseParts({ part: 1, vectorDim: 2384 })))
  })
})

describe('contentHash', () => {
  it('renders the 64-char lowercase sha256 hex digest', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{64}$/)
    // sha256("hello") is a fixed, independently checkable value.
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('hashes equal bytes identically across string and Uint8Array forms', () => {
    const asString = contentHash('note body\n')
    const asBytes = contentHash(new TextEncoder().encode('note body\n'))
    expect(asBytes).toBe(asString)
    expect(contentHash(Buffer.from('note body\n'))).toBe(asString)
  })

  it('changes digest when a single byte changes', () => {
    expect(contentHash('updated: 2026-11-12')).not.toBe(contentHash('updated: 2026-11-13'))
  })
})

describe('headerHash', () => {
  it('renders the 16-char lowercase hex prefix, stable per input', () => {
    const first = headerHash('Alpha > Beta\nsome normalized section text')
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(headerHash('Alpha > Beta\nsome normalized section text')).toBe(first)
    expect(headerHash('Alpha > Beta\nother text')).not.toBe(first)
  })
})
