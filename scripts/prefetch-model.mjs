#!/usr/bin/env node
/**
 * PrefetchModel downloads the embedding model once into the plugin's model
 * cache so first use is a cache hit and offline machines can be prepared in
 * advance.
 *
 * It loads the exact pipeline the service embedder builds (same model id,
 * same q8 dtype, same cache dir layout), which pulls the q8 ONNX
 * (model_quantized.onnx, ~118 MB) plus the tokenizer (~17 MB) and the
 * config files. Point it at the same directory the plugin will use; the
 * service sets env.cacheDir = modelCacheDir(homedir) by default.
 *
 * Usage:
 *   node scripts/prefetch-model.mjs [cacheDir]
 *
 * The cache dir resolves, in order: the positional argument, then
 * $DSH_MEM_MODEL_CACHE, then core's modelCacheDir(os.homedir()).
 * Requires `pnpm build` first (it reads core constants from lib/).
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const coreConstantsPath = path.join(root, 'packages/core/lib/constants.js')
if (!existsSync(coreConstantsPath)) {
  console.error(`missing ${coreConstantsPath}; run \`pnpm build\` first.`)
  process.exit(1)
}
const {
  DEFAULT_MODEL_ID,
  TRANSFORMERS_PIPELINE_OPTIONS,
  modelCacheDir,
} = await import(pathToFileURL(coreConstantsPath).href)

const positional = process.argv[2]
const cacheDir = positional ?? process.env.DSH_MEM_MODEL_CACHE ?? modelCacheDir(os.homedir())

const { env, pipeline } = await import('@huggingface/transformers')
env.cacheDir = cacheDir
env.allowLocalModels = false
env.allowRemoteModels = true

console.log(`prefetch: model ${DEFAULT_MODEL_ID} (${TRANSFORMERS_PIPELINE_OPTIONS.dtype}) -> ${cacheDir}`)

const extractor = await pipeline('feature-extraction', DEFAULT_MODEL_ID, {
  dtype: TRANSFORMERS_PIPELINE_OPTIONS.dtype,
  progress_callback: ({ status, file, progress }) => {
    if (file) {
      const pct = typeof progress === 'number' ? ` ${progress.toFixed(1)}%` : ''
      console.log(`prefetch: ${status} ${file}${pct}`)
    }
  },
})

// One real inference call proves the cache is complete and usable: the
// pipeline never downloads what it does not load.
const output = await extractor(['prefetch smoke'], {
  pooling: TRANSFORMERS_PIPELINE_OPTIONS.pooling,
  normalize: TRANSFORMERS_PIPELINE_OPTIONS.normalize,
})
await extractor.dispose?.()

console.log(`prefetch: ok, output dims ${JSON.stringify(output.dims)}`)
