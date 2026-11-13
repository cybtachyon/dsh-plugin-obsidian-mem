/**
 * Embedder wraps the @huggingface/transformers feature-extraction pipeline
 * behind this plugin's passage/query prefix contract and the vectorDim knob.
 *
 * The pipeline loads lazily and single-flight on the first embed call, so
 * plugin activation never touches the model or the network. A startup probe
 * asserts ‖v‖≈1 once per singleton because transformers.js v4 silently
 * ignores the v3 option spelling `normalization`; un-normalized vectors must
 * fail loudly here, not quietly poison a COSINE index (findings §6.1).
 * @module dsh-plugin-obsidian-mem/service/embedder
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

import {
  DEFAULT_MODEL_ID,
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  TRANSFORMERS_PIPELINE_OPTIONS,
  VECTOR_DIM_DEFAULT,
  VECTOR_DIM_LOSSY,
  isVectorDim,
  modelCacheDir,
} from '../../core/lib/index.js'

/** One embedding row; length equals the Embedder's stored dim. */
export type EmbeddingVector = number[]

/**
 * FeatureExtractor is the structural slice of the transformers.js v4
 * feature-extraction pipeline this module calls. Declaring it here instead of
 * importing the pipeline type keeps unit tests injectable without loading
 * onnxruntime, and documents the exact call options that matter.
 */
export type FeatureExtractor = (
  texts: readonly string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ dims: number[]; data: ArrayLike<number> }>

/**
 * Embedder is the seam the indexer (TASK-023) and hybrid search (TASK-024)
 * embed through. Prefixes belong here, at embed time only: stored chunk_text
 * stays clean so BM25 is not polluted (findings §6.6).
 */
export interface Embedder {
  /** Model id this embedder embeds with. */
  readonly modelId: string
  /** Stored vector width; never larger than the model's output width. */
  readonly dim: number
  /** Embeds indexed passages, prepending PASSAGE_PREFIX to each text. */
  embedPassages(texts: readonly string[]): Promise<EmbeddingVector[]>
  /** Embeds one search query, prepending QUERY_PREFIX. */
  embedQuery(text: string): Promise<EmbeddingVector>
}

/** Constructor options for createEmbedder; every field has a production default. */
export interface EmbedderOptions {
  /** Model id; default DEFAULT_MODEL_ID (e5-small, 384-d). */
  modelId?: string
  /**
   * Stored width: VECTOR_DIM_DEFAULT or one of VECTOR_DIM_LOSSY. Values
   * below the model width slice and renormalize, a documented LOSSY
   * truncation (e5-small is not MRL-trained; ~14% recall@10 loss at 256,
   * findings §6.7); each value is baked into the collection, so changing it
   * forces a full re-index.
   */
  vectorDim?: number
  /** transformers.js cache dir; default modelCacheDir(homedir). */
  cacheDir?: string
  /** Home base for the default cacheDir; default os.homedir(). */
  homedir?: string
  /** Texts per pipeline call; default EMBED_BATCH_SIZE. */
  batchSize?: number
  /**
   * Pipeline loader seam. Tests inject a fake extractor here; production
   * uses loadTransformersExtractor, and the fake never touches env, fs, or
   * the network.
   */
  extractorLoader?: (options: { modelId: string; cacheDir: string }) => Promise<FeatureExtractor>
}

/** Texts handed to the pipeline in one call. */
export const EMBED_BATCH_SIZE = 32

// L2-norm tolerance for the startup probe. Verified q8 output lands at
// 1.0000; the silent-normalization failure mode lands at ~4.5 (findings
// §6.1), so 1e-3 separates the two by orders of magnitude.
const NORM_TOLERANCE = 1e-3

// Text embedded once at startup purely for the norm/width assertions.
const PROBE_TEXT = 'obsidian-mem embedder startup probe'

// Call options picked verbatim from the core constant: the v4 spelling
// `normalize` is load-bearing and lives in one place (TRANSFORMERS_PIPELINE_OPTIONS).
const { pooling, normalize } = TRANSFORMERS_PIPELINE_OPTIONS

/**
 * CreateEmbedder builds an Embedder whose pipeline loads on first use.
 * Concurrent embed calls share one pipeline load (single-flight) and one
 * serialized inference queue, so an embedding burst never starts several
 * onnxruntime sessions or reentrantly calls one pipeline.
 */
export function createEmbedder(options: EmbedderOptions = {}): Embedder {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID
  const vectorDim = options.vectorDim ?? VECTOR_DIM_DEFAULT
  if (!isVectorDim(vectorDim)) {
    throw new RangeError(
      `embedder: vectorDim ${vectorDim} is not ${VECTOR_DIM_DEFAULT} or a lossy `
      + `opt-in (${VECTOR_DIM_LOSSY.join(', ')}); lossy widths force a full re-index`,
    )
  }
  const cacheDir = options.cacheDir ?? modelCacheDir(options.homedir ?? homedir())
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE
  const loadExtractor = options.extractorLoader ?? loadTransformersExtractor

  let extractorPromise: Promise<FeatureExtractor> | null = null
  let modelWidth = 0
  let queueTail: Promise<unknown> = Promise.resolve()

  // Serialize every pipeline call: onnxruntime sessions are not safe to
  // reenter from one process, and a TS queue is the lightest guard.
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queueTail.then(task, task)
    queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function ensureExtractor(): Promise<FeatureExtractor> {
    if (extractorPromise === null) {
      extractorPromise = loadAndProbe()
    }
    return extractorPromise
  }

  async function loadAndProbe(): Promise<FeatureExtractor> {
    let extractor: FeatureExtractor
    try {
      extractor = await loadExtractor({ modelId, cacheDir })
    } catch (cause) {
      // Drop the failed load so the next call may retry (the network may
      // come back); this call still carries the actionable first failure.
      extractorPromise = null
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new Error(
        `embedder: could not load model "${modelId}" (cache ${cacheDir}): ${reason}. `
        + 'If this machine is offline, pre-seed the cache once with: '
        + 'node scripts/prefetch-model.mjs',
        { cause },
      )
    }

    const probe = await enqueue(() => extractor([PROBE_TEXT], { pooling, normalize }))
    modelWidth = probe.dims.at(-1) ?? 0
    if (modelWidth < vectorDim) {
      throw new Error(
        `embedder: model "${modelId}" emits ${modelWidth}-d vectors but vectorDim `
        + `is ${vectorDim}; raise vectorDim or switch modelId`,
      )
    }
    const norm = l2Norm(probe.data, 0, modelWidth)
    if (Math.abs(norm - 1) > NORM_TOLERANCE) {
      throw new Error(
        `embedder: model "${modelId}" returned ‖v‖=${norm.toFixed(4)} for the startup `
        + 'probe. transformers.js v4 normalizes only under the call option '
        + '`normalize: true` (the v3 spelling `normalization` is silently ignored); '
        + 'refusing to index un-normalized vectors.',
      )
    }
    return extractor
  }

  // The vectorDim knob: the model always emits its full width; storing fewer
  // dims is the documented-lossy truncation. Renormalizing after the slice
  // keeps every stored vector unit-length for COSINE.
  function toStoredWidth(full: readonly number[]): number[] {
    if (full.length === vectorDim) {
      return full.slice()
    }
    const truncated = full.slice(0, vectorDim)
    const norm = l2Norm(truncated, 0, truncated.length)
    return norm === 0 ? truncated : truncated.map((value) => value / norm)
  }

  function tensorRows(tensor: { dims: number[]; data: ArrayLike<number> }): number[][] {
    const width = tensor.dims.at(-1) ?? 0
    const rowCount = tensor.dims[0] ?? 0
    if (width !== modelWidth) {
      throw new Error(
        `embedder: pipeline returned ${width}-d rows but the startup probe measured `
        + `${modelWidth}-d; refusing to mix widths`,
      )
    }
    if (tensor.data.length < rowCount * width) {
      throw new Error('embedder: pipeline output is shorter than its dims promise')
    }
    const rows: number[][] = []
    for (let row = 0; row < rowCount; row += 1) {
      const full: number[] = []
      for (let column = 0; column < width; column += 1) {
        full.push(tensor.data[row * width + column] as number)
      }
      rows.push(toStoredWidth(full))
    }
    return rows
  }

  async function embedPrefixed(prefixed: readonly string[]): Promise<number[][]> {
    const extractor = await ensureExtractor()
    const rows: number[][] = []
    for (let start = 0; start < prefixed.length; start += batchSize) {
      const batch = prefixed.slice(start, start + batchSize)
      const tensor = await enqueue(() => extractor(batch, { pooling, normalize }))
      rows.push(...tensorRows(tensor))
    }
    return rows
  }

  return {
    modelId,
    dim: vectorDim,
    embedPassages: (texts) => embedPrefixed(texts.map((text) => `${PASSAGE_PREFIX}${text}`)),
    embedQuery: async (text) => {
      const rows = await embedPrefixed([`${QUERY_PREFIX}${text}`])
      const row = rows[0]
      if (!row) {
        throw new Error('embedder: query embedding returned no rows')
      }
      return row
    },
  }
}

/**
 * FakeEmbedder returns an Embedder whose vectors are a deterministic
 * hash→unit-vector function of the prefixed text. Tests of the indexer,
 * search, tools, and hooks embed through it instead of loading onnxruntime
 * or the ~135 MB model; identical texts always yield identical vectors.
 * vectorDim is unrestricted (any positive width) so schemas can be exercised
 * at small sizes; the real createEmbedder keeps the strict whitelist.
 */
export function fakeEmbedder(options: { modelId?: string; vectorDim?: number } = {}): Embedder {
  const modelId = options.modelId ?? 'fake-deterministic-embedder'
  const dim = options.vectorDim ?? VECTOR_DIM_DEFAULT
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError(`fakeEmbedder: vectorDim ${dim} must be a positive integer`)
  }
  return {
    modelId,
    dim,
    embedPassages: async (texts) => texts.map((text) => fakeVector(`${PASSAGE_PREFIX}${text}`, dim)),
    embedQuery: async (text) => fakeVector(`${QUERY_PREFIX}${text}`, dim),
  }
}

/** LoadTransformersExtractor loads the v4 pipeline from the configured cache. */
async function loadTransformersExtractor(
  options: { modelId: string; cacheDir: string },
): Promise<FeatureExtractor> {
  // Dynamic import keeps onnxruntime out of every process that only uses
  // fakeEmbedder or unit-injected extractors (and out of the module graph
  // until the first real embed).
  const { env, pipeline } = await import('@huggingface/transformers')
  mkdirSync(options.cacheDir, { recursive: true })
  env.cacheDir = options.cacheDir
  env.allowLocalModels = false
  env.allowRemoteModels = true
  const extractor = await pipeline('feature-extraction', options.modelId, {
    dtype: TRANSFORMERS_PIPELINE_OPTIONS.dtype,
  })
  // Structural cast: the pipeline type is a callable union over tensor
  // payload types; only the documented slice above is used.
  return extractor as unknown as FeatureExtractor
}

/** FakeVector maps text to a stable unit vector via FNV-1a + mulberry32. */
function fakeVector(text: string, dim: number): number[] {
  const random = mulberry32(fnv1a(text))
  const vector: number[] = []
  for (let index = 0; index < dim; index += 1) {
    vector.push(random() * 2 - 1)
  }
  const norm = l2Norm(vector, 0, vector.length)
  return norm === 0 ? vector : vector.map((value) => value / norm)
}

/** Fnv1a hashes text to a 32-bit unsigned integer. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Mulberry32 builds a small deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** L2Norm computes the Euclidean norm of values[start, end). */
function l2Norm(values: ArrayLike<number>, start: number, end: number): number {
  let sum = 0
  for (let index = start; index < end; index += 1) {
    const value = values[index] as number
    sum += value * value
  }
  return Math.sqrt(sum)
}
