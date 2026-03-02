// ─── Core Domain Types ────────────────────────────────────────────────────────

export interface DocumentChunk {
  id: string;
  text: string;
  metadata: ChunkMetadata;
  embedding?: number[];
}

export interface ChunkMetadata {
  source: string;
  fileName: string;
  pageNumber?: number;
  section?: string;
  chunkIndex: number;
  totalChunks: number;
  ingestedAt: string;
}

// ─── BM25 Index Types ─────────────────────────────────────────────────────────

export interface BM25Document {
  id: string;
  tokens: string[];
  metadata: ChunkMetadata;
  text: string;
}

export interface BM25Index {
  version: string;
  createdAt: string;
  documents: BM25Document[];
  idf: Record<string, number>;
  avgDocLength: number;
}

// ─── Retrieval Types ──────────────────────────────────────────────────────────

export interface RetrievalResult {
  chunk: DocumentChunk;
  score: number;
  retrievalMethod: "bm25" | "vector" | "hybrid";
}

export interface RerankResult {
  chunk: DocumentChunk;
  originalScore: number;
  rerankScore: number;
  rank: number;
}

export interface HybridRetrievalConfig {
  bm25TopK: number;
  vectorTopK: number;
  finalTopN: number;
  rrfK: number;
}

// ─── Generation Types ─────────────────────────────────────────────────────────

export interface Citation {
  id: number;
  source: string;
  fileName: string;
  pageNumber?: number;
  text: string;
}

export interface RAGResponse {
  answer: string;
  citations: Citation[];
  retrievedChunks: RerankResult[];
  metadata: ResponseMetadata;
}

export interface ResponseMetadata {
  queryTime: number;
  retrievalTime: number;
  rerankTime: number;
  generationTime: number;
  totalTime: number;
  model: string;
  chunksRetrieved: number;
  chunksAfterRerank: number;
}

// ─── Ingestion Types ──────────────────────────────────────────────────────────

export interface IngestionResult {
  success: boolean;
  fileName: string;
  chunksCreated: number;
  errors?: string[];
}

export interface IngestionConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
}

// ─── Query / API Types ────────────────────────────────────────────────────────

export interface QueryRequest {
  question: string;
  topK?: number;
}

export interface QueryResponse {
  success: boolean;
  data: RAGResponse;
}

export interface IngestResponse {
  success: boolean;
  results: IngestionResult[];
}

// ─── Evaluation Types ─────────────────────────────────────────────────────────

export interface GoldenSample {
  id: string;
  question: string;
  groundTruthAnswer: string;
  relevantSources: string[];
}

export interface EvalMetrics {
  faithfulness: number;
  answerRelevancy: number;
  contextPrecision: number;
  contextRecall: number;
}

export interface EvalResult {
  sampleId: string;
  question: string;
  generatedAnswer: string;
  groundTruthAnswer: string;
  metrics: EvalMetrics;
  citations: Citation[];
  passed: boolean;
}

export interface EvalReport {
  timestamp: string;
  totalSamples: number;
  passed: number;
  failed: number;
  averageMetrics: EvalMetrics;
  thresholds: EvalMetrics;
  results: EvalResult[];
  overallPassed: boolean;
}
