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
/** One embedding row; length equals the Embedder's stored dim. */
export type EmbeddingVector = number[];
/**
 * FeatureExtractor is the structural slice of the transformers.js v4
 * feature-extraction pipeline this module calls. Declaring it here instead of
 * importing the pipeline type keeps unit tests injectable without loading
 * onnxruntime, and documents the exact call options that matter.
 */
export type FeatureExtractor = (texts: readonly string[], options: {
    pooling: 'mean';
    normalize: true;
}) => Promise<{
    dims: number[];
    data: ArrayLike<number>;
}>;
/**
 * Embedder is the seam the indexer (TASK-023) and hybrid search (TASK-024)
 * embed through. Prefixes belong here, at embed time only: stored chunk_text
 * stays clean so BM25 is not polluted (findings §6.6).
 */
export interface Embedder {
    /** Model id this embedder embeds with. */
    readonly modelId: string;
    /** Stored vector width; never larger than the model's output width. */
    readonly dim: number;
    /** Embeds indexed passages, prepending PASSAGE_PREFIX to each text. */
    embedPassages(texts: readonly string[]): Promise<EmbeddingVector[]>;
    /** Embeds one search query, prepending QUERY_PREFIX. */
    embedQuery(text: string): Promise<EmbeddingVector>;
}
/** Constructor options for createEmbedder; every field has a production default. */
export interface EmbedderOptions {
    /** Model id; default DEFAULT_MODEL_ID (e5-small, 384-d). */
    modelId?: string;
    /**
     * Stored width: VECTOR_DIM_DEFAULT or one of VECTOR_DIM_LOSSY. Values
     * below the model width slice and renormalize, a documented LOSSY
     * truncation (e5-small is not MRL-trained; ~14% recall@10 loss at 256,
     * findings §6.7); each value is baked into the collection, so changing it
     * forces a full re-index.
     */
    vectorDim?: number;
    /** transformers.js cache dir; default modelCacheDir(homedir). */
    cacheDir?: string;
    /** Home base for the default cacheDir; default os.homedir(). */
    homedir?: string;
    /** Texts per pipeline call; default EMBED_BATCH_SIZE. */
    batchSize?: number;
    /**
     * ONNX quantization passed to the pipeline loader; default
     * TRANSFORMERS_PIPELINE_OPTIONS.dtype (q8). Only the production loader
     * reads it; an injected extractorLoader receives the model/cache pair and
     * owns its own dtype.
     */
    dtype?: string;
    /**
     * Pipeline loader seam. Tests inject a fake extractor here; production
     * uses loadTransformersExtractor, and the fake never touches env, fs, or
     * the network.
     */
    extractorLoader?: (options: {
        modelId: string;
        cacheDir: string;
    }) => Promise<FeatureExtractor>;
}
/** Texts handed to the pipeline in one call. */
export declare const EMBED_BATCH_SIZE = 32;
/**
 * CreateEmbedder builds an Embedder whose pipeline loads on first use.
 * Concurrent embed calls share one pipeline load (single-flight) and one
 * serialized inference queue, so an embedding burst never starts several
 * onnxruntime sessions or reentrantly calls one pipeline.
 */
export declare function createEmbedder(options?: EmbedderOptions): Embedder;
/**
 * FakeEmbedder returns an Embedder whose vectors are a deterministic
 * hash→unit-vector function of the prefixed text. Tests of the indexer,
 * search, tools, and hooks embed through it instead of loading onnxruntime
 * or the ~135 MB model; identical texts always yield identical vectors.
 * vectorDim is unrestricted (any positive width) so schemas can be exercised
 * at small sizes; the real createEmbedder keeps the strict whitelist.
 */
export declare function fakeEmbedder(options?: {
    modelId?: string;
    vectorDim?: number;
}): Embedder;
//# sourceMappingURL=embedder.d.ts.map
