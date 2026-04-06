/**
 * mcp-ai-brain — Local Embedding Engine (v1.1)
 *
 * Runs sentence embeddings 100% locally using @xenova/transformers.
 * Model: Xenova/all-MiniLM-L6-v2 (~25MB, 384-dim, downloads once to cache).
 *
 * Design decisions:
 * - Lazy-loaded pipeline: only downloads model on first use
 * - Shared Promise: concurrent callers share one initialization flight
 * - Graceful degradation: returns null if model unavailable
 * - Zero external API calls — all computation is local
 */

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmbeddingPipeline = (text: string, opts?: Record<string, unknown>) => Promise<any>;

// Shared initialization promise — prevents concurrent model downloads
let initPromise: Promise<EmbeddingPipeline | null> | null = null;
let pipelineInstance: EmbeddingPipeline | null = null;
let pipelineReady = false;
let pipelineFailed = false;

/**
 * Lazy-load the embedding pipeline. Downloads model on first call (~25MB),
 * cached to ~/.cache/huggingface/hub after that.
 *
 * Concurrent callers share the same Promise — only one download ever happens.
 */
async function getEmbeddingPipeline(): Promise<EmbeddingPipeline | null> {
  // Fast path: already ready
  if (pipelineReady && pipelineInstance) return pipelineInstance;

  // Fast path: already failed — don't retry in this process
  if (pipelineFailed) return null;

  // Share one initialization Promise across all concurrent callers
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // Dynamic import — graceful if package not installed
        const { pipeline } = await import("@xenova/transformers");
        const pipe = await pipeline("feature-extraction", MODEL_NAME, {
          quantized: true, // Use int8 quantized model (~25MB vs ~90MB)
        });

        pipelineInstance = async (text: string) => {
          return pipe(text, { pooling: "mean", normalize: true });
        };

        pipelineReady = true;
        return pipelineInstance;
      } catch {
        pipelineFailed = true;
        // Silently degrade — FTS keyword search still works
        return null;
      }
    })();
  }

  return initPromise;
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
    // Handle both Float32Array and plain number[] from transformers output
    if (output.data instanceof Float32Array) return output.data;
    return new Float32Array(output.data as number[]);
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two normalized vectors.
 * Returns a value in [-1, 1] where 1 = identical.
 * Since MiniLM output is normalize:true, this is equivalent to dot product.
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

/**
 * Trigger model pre-load without blocking.
 * Call once at server startup so first remember() doesn't cold-start.
 */
export function warmupEmbeddings(): void {
  void getEmbeddingPipeline();
}
