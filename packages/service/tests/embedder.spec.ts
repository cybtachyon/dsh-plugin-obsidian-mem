import { describe, expect, it } from 'vitest'

import { VECTOR_DIM_DEFAULT } from '../../core/lib/index.js'
import {
  EMBED_BATCH_SIZE,
  createEmbedder,
  fakeEmbedder,
  type FeatureExtractor,
} from '../src/embedder.ts'

/**
 * Unit tests for the embedder seam: prefix discipline, batching,
 * single-flight loading, the startup norm/width assertions, the lossy
 * vectorDim knob, and the deterministic fake. All run against an injected
 * fake extractor; the RUN_LIVE smoke at the bottom is the only test that
 * touches the real transformers.js model.
 */

interface ExtractorCall {
  texts: readonly string[]
  options: unknown
}

/**
 * FakePipeline builds a FeatureExtractor stub plus its call log. mode
 * controls vector content: unit vectors pass the startup assertion,
 * unnormalized vectors fail it, and ramp vectors are unit-normalized
 * ramps so truncation expectations are closed-form.
 */
function fakePipeline(options: { dim?: number; mode?: 'unit' | 'unnormalized' | 'ramp' } = {}) {
  const dim = options.dim ?? VECTOR_DIM_DEFAULT
  const mode = options.mode ?? 'unit'
  const calls: ExtractorCall[] = []
  const rawNorm = mode === 'ramp' ? Math.sqrt(sumOfSquares(dim)) : Math.sqrt(dim)
  const extract: FeatureExtractor = async (texts, extractOptions) => {
    calls.push({ texts, options: extractOptions })
    const data = new Float32Array(texts.length * dim)
    for (let row = 0; row < texts.length; row += 1) {
      for (let column = 0; column < dim; column += 1) {
        const raw = mode === 'ramp' ? column + 1 : 1
        // unnormalized deliberately skips the divide: norm lands at sqrt(dim).
        data[row * dim + column] = mode === 'unnormalized' ? raw : raw / rawNorm
      }
    }
    return { dims: [texts.length, dim], data }
  }
  return { extract, calls }
}

/** SumOfSquares returns 1^2 + 2^2 + ... + n^2. */
function sumOfSquares(n: number): number {
  return (n * (n + 1) * (2 * n + 1)) / 6
}

/** Cosine returns the cosine of two equal-length vectors. */
function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
  }
  return dot
}

describe('createEmbedder', () => {
  it('applies the passage and query prefixes and the verified v4 call options', async () => {
    const { extract, calls } = fakePipeline()
    const embedder = createEmbedder({ extractorLoader: async () => extract })

    await embedder.embedPassages(['alpha', 'beta'])
    await embedder.embedQuery('gamma')

    // calls[0] is the startup probe; embed calls follow in order.
    expect(calls).toHaveLength(3)
    expect(calls[0]!.texts).toHaveLength(1)
    expect(calls[1]!.texts).toEqual(['passage: alpha', 'passage: beta'])
    expect(calls[2]!.texts).toEqual(['query: gamma'])
    // findings §6.1: v4 renamed `normalization` to `normalize`; the exact
    // spelling sent at call time is the load-bearing contract.
    expect(calls[1]!.options).toEqual({ pooling: 'mean', normalize: true })
  })

  it('batches embed calls at EMBED_BATCH_SIZE texts per pipeline call', async () => {
    const { extract, calls } = fakePipeline()
    const embedder = createEmbedder({ extractorLoader: async () => extract })
    const texts = Array.from({ length: 70 }, (_unused, index) => `text ${index}`)

    const vectors = await embedder.embedPassages(texts)

    expect(vectors).toHaveLength(70)
    const batchSizes = calls.slice(1).map((call) => call.texts.length)
    expect(batchSizes).toEqual([
      EMBED_BATCH_SIZE,
      EMBED_BATCH_SIZE,
      70 - 2 * EMBED_BATCH_SIZE,
    ])
  })

  it('loads the pipeline once for concurrent embed calls (single-flight)', async () => {
    let loads = 0
    const { extract } = fakePipeline()
    const embedder = createEmbedder({
      extractorLoader: async () => {
        loads += 1
        return extract
      },
    })

    await Promise.all([
      embedder.embedQuery('one'),
      embedder.embedQuery('two'),
      embedder.embedPassages(['three', 'four']),
    ])

    expect(loads).toBe(1)
  })

  it('fails loudly at startup when vectors are not L2-normalized', async () => {
    const { extract } = fakePipeline({ mode: 'unnormalized' })
    const embedder = createEmbedder({ extractorLoader: async () => extract })

    await expect(embedder.embedQuery('anything')).rejects.toThrow(
      /norm|normalize/i,
    )
  })

  it('fails when the model width cannot supply the requested vectorDim', async () => {
    const { extract } = fakePipeline({ dim: 128 })
    const embedder = createEmbedder({ extractorLoader: async () => extract })

    await expect(embedder.embedQuery('anything')).rejects.toThrow(/128-d/)
  })

  it('wraps model load failures with the offline prefetch hint', async () => {
    let attempts = 0
    const embedder = createEmbedder({
      cacheDir: '/tmp/embedder-test-cache',
      extractorLoader: async () => {
        attempts += 1
        throw new Error('fetch failed: offline')
      },
    })

    await expect(embedder.embedQuery('anything')).rejects.toThrow(
      /could not load model[\s\S]*prefetch-model\.mjs/,
    )
    // The failed load must not be cached: a retry calls the loader again.
    await expect(embedder.embedQuery('anything')).rejects.toThrow(/prefetch-model\.mjs/)
    expect(attempts).toBe(2)
  })

  it('slices and renormalizes for a lossy vectorDim', async () => {
    const { extract } = fakePipeline({ mode: 'ramp' })
    const embedder = createEmbedder({ vectorDim: 256, extractorLoader: async () => extract })

    const [vector] = await embedder.embedPassages(['one'])

    expect(vector).toHaveLength(256)
    // Ramp input is (k / N384) unit-normalized; slicing to 256 and
    // renormalizing yields exactly k / N256.
    const expectedScale = 1 / Math.sqrt(sumOfSquares(256))
    for (let index = 0; index < 256; index += 1) {
      // 8 decimals: the fake stores vectors in a Float32Array, so exact
      // float64 expectations only agree to ~1e-10.
      expect(vector[index]).toBeCloseTo((index + 1) * expectedScale, 8)
    }
    expect(cosine(vector!, vector!)).toBeCloseTo(1, 6)
  })

  it('keeps full-width vectors untouched at the default dim', async () => {
    const { extract } = fakePipeline()
    const embedder = createEmbedder({ extractorLoader: async () => extract })

    const [vector] = await embedder.embedPassages(['one'])

    expect(vector).toHaveLength(VECTOR_DIM_DEFAULT)
    expect(embedder.dim).toBe(VECTOR_DIM_DEFAULT)
  })

  it('rejects vectorDim values outside the default and lossy opt-ins', () => {
    expect(() => createEmbedder({ vectorDim: 999 })).toThrow(RangeError)
    expect(() => createEmbedder({ vectorDim: 385 })).toThrow(RangeError)
  })
})

describe('fakeEmbedder', () => {
  it('returns identical unit vectors for identical prefixed texts', async () => {
    const embedder = fakeEmbedder({ vectorDim: 16 })
    const first = await embedder.embedQuery('hello world')
    const second = await embedder.embedQuery('hello world')
    const other = await embedder.embedQuery('hello world!')

    expect(first).toEqual(second)
    expect(first).not.toEqual(other)
    expect(cosine(first, first)).toBeCloseTo(1, 6)
    expect(embedder.dim).toBe(16)
  })

  it('distinguishes passage and query forms of the same text', async () => {
    const embedder = fakeEmbedder({ vectorDim: 16 })
    const [passage] = await embedder.embedPassages(['same text'])
    const query = await embedder.embedQuery('same text')

    expect(passage).not.toEqual(query)
  })

  it('defaults to the production 384-d width and a labeled modelId', () => {
    const embedder = fakeEmbedder()

    expect(embedder.dim).toBe(VECTOR_DIM_DEFAULT)
    expect(embedder.modelId).toContain('fake')
  })
})

// Live tier (PLAN: slow-tagged smoke, skipped unless RUN_LIVE=1): pulls the
// ~135 MB q8 model into the default cache on first run.
const describeLive = process.env.RUN_LIVE === '1' ? describe : describe.skip
describeLive('embedder live model smoke (RUN_LIVE=1)', () => {
  it(
    'embeds with the real q8 model at 384-d, unit norms, and related>unrelated cosine',
    async () => {
      const embedder = createEmbedder()
      const [catPassage, carPassage] = await embedder.embedPassages([
        'a cat sits on the warm windowsill purring',
        'the car engine would not start this morning',
      ])
      const query = await embedder.embedQuery('cat')

      expect(embedder.dim).toBe(VECTOR_DIM_DEFAULT)
      for (const vector of [catPassage, carPassage, query]) {
        expect(vector).toHaveLength(VECTOR_DIM_DEFAULT)
        expect(Math.hypot(...vector)).toBeCloseTo(1, 3)
      }
      // findings §6.6: with the prefixes the correct passage ranks first;
      // without them the ranking flips. This is the regression pin.
      expect(cosine(query, catPassage!)).toBeGreaterThan(cosine(query, carPassage!))
    },
    600_000,
  )
})
