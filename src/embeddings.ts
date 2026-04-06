/**
 * mcp-ai-brain — Local Embedding Engine (v1.1)
 *
 * Runs sentence embeddings 100% locally using @xenova/transformers.
 * Model: Xenova/all-MiniLM-L6-v2 (~25MB, 384-dim, downloads once to cache).
 *
 * Design decisions:
 * - Lazy-loaded pipeline: only downloads model on first use
 * - Cached singleton: one pipeline instance per process
 * - Graceful degradation: returns null if model unavailable
 * - Zero external API calls — all computation is local
 */

// Dynamic import so the module loads even if transformers isn't installed
// (e.g. in environments where optional deps aren't available)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: ((text: string, opts?: Record<string, unknown>) => Promise<any>) | null = null;
let pipelineLoading = false;
let pipelineReady = false;
let pipelineFailed = false;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/**
 * Lazy-load the embedding pipeline. Downloads model on first call (~25MB),
 * cached to ~/.cache/huggingface/hub after that.
 */
async function getEmbeddingPipeline(): Promise<
  ((text: string) => Promise<{ data: Float32Array }>) | null
> {
  if (pipelineReady && pipelineInstance) return pipelineInstance;
  if (pipelineFailed) return null;
  if (pipelineLoading) {
    // Wait for concurrent load
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!pipelineLoading) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
    return pipelineInstance;
  }

  pipelineLoading = true;

  try {
    // Dynamic import — graceful if package not installed
    const { pipeline } = await import("@xenova/transformers");
    const pipe = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true, // Use int8 quantized model (~25MB vs ~90MB)
    });

    pipelineInstance = async (text: string) => {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      return output;
    };

    pipelineReady = true;
    pipelineLoading = false;
    return pipelineInstance;
  } catch (err) {
    pipelineFailed = true;
    pipelineLoading = false;
    // Silently degrade — FTS search still works
    return null;
  }
}

/**
 * Generate a 384-dim embedding for a text string.
 * Returns null if the model isn't available (graceful degradation).
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getEmbeddingPipeline();
    if (!pipe) return null;

    const output = await pipe(text);
    return output.data instanceof Float32Array
      ? output.data
      : new Float32Array(output.data);
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two 384-dim vectors.
 * Returns a value in [-1, 1] where 1 = identical.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Deserialize BLOB from SQLite back to Float32Array.
 */
export function deserializeEmbedding(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Check if the embedding model is available without triggering a load.
 */
export function isEmbeddingAvailable(): boolean {
  return pipelineReady;
}
