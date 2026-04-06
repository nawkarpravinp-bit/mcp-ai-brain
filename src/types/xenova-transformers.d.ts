/**
 * Type declarations for @xenova/transformers.
 * The package ships CJS + ESM but lacks full TS declarations.
 * We declare the minimal surface we use for type-safety.
 */
declare module "@xenova/transformers" {
  type PipelineType =
    | "feature-extraction"
    | "text-classification"
    | "token-classification"
    | "question-answering"
    | "summarization"
    | "translation"
    | "text-generation"
    | "fill-mask"
    | "zero-shot-classification"
    | "audio-classification"
    | "automatic-speech-recognition"
    | "image-classification"
    | "image-segmentation"
    | "object-detection"
    | "document-question-answering"
    | "image-to-text";

  interface PipelineOptions {
    quantized?: boolean;
    revision?: string;
    cache_dir?: string;
    local_files_only?: boolean;
    dtype?: string;
  }

  interface FeatureExtractionOutput {
    data: Float32Array | number[];
    dims: number[];
    size: number;
    type: string;
  }

  type FeatureExtractionPipeline = (
    text: string | string[],
    options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean }
  ) => Promise<FeatureExtractionOutput>;

  function pipeline(
    task: "feature-extraction",
    model?: string,
    options?: PipelineOptions
  ): Promise<FeatureExtractionPipeline>;

  function pipeline(
    task: PipelineType,
    model?: string,
    options?: PipelineOptions
  ): Promise<(...args: unknown[]) => Promise<unknown>>;

  class Pipeline {
    task: string;
    model: string;
    dispose(): Promise<void>;
  }

  const env: {
    cacheDir: string;
    remoteHost: string;
    remotePathTemplate: string;
    localModelPath: string | null;
    useFS: boolean;
    useBrowserCache: boolean;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    backends: {
      onnx: {
        wasm: {
          numThreads: number;
          simd: boolean;
          proxy: boolean;
        };
      };
    };
  };
}
