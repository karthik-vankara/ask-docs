import type { RAGResponse, QueryRequest } from "./types/index.js";
import { BM25IndexManager } from "./retrieval/bm25.js";
import { HybridRetriever } from "./retrieval/hybrid-retriever.js";
import { CrossEncoderReranker } from "./reranking/reranker.js";
import { RAGChain } from "./generation/rag-chain.js";
import { logger } from "./api/logger.js";

// ─── Pipeline Orchestrator ────────────────────────────────────────────────────
// Flow: HybridRetriever → CrossEncoderReranker → RAGChain (with citations)

export class RAGPipeline {
  private bm25Manager: BM25IndexManager;
  private retriever: HybridRetriever;
  private reranker: CrossEncoderReranker;
  private chain: RAGChain;
  private initialized = false;

  constructor() {
    this.bm25Manager = new BM25IndexManager(
      process.env["BM25_INDEX_PATH"] ?? "./data/bm25-index.json"
    );

    this.retriever = new HybridRetriever(this.bm25Manager, {
      bm25TopK: 20,
      vectorTopK: 20,
      finalTopN: 10,
      rrfK: 60,
    });

    this.reranker = new CrossEncoderReranker(5);
    this.chain = new RAGChain("gpt-4o-mini");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.bm25Manager.load();
    await this.retriever.initialize();
    this.initialized = true;
    logger.info("RAG Pipeline ready");
  }

  async query(request: QueryRequest): Promise<RAGResponse> {
    await this.initialize();
    const pipelineStart = Date.now();

    // 1. Hybrid Retrieval (BM25 + Vector + RRF)
    const retrievalStart = Date.now();
    const retrieved = await this.retriever.retrieve(request.question);
    const retrievalTime = Date.now() - retrievalStart;

    // 2. Cross-Encoder Reranking (Cohere)
    const rerankStart = Date.now();
    const reranked = await this.reranker.rerank(request.question, retrieved);
    const rerankTime = Date.now() - rerankStart;

    // 3. Citation-Enforced Generation (GPT-4o-mini)
    const response = await this.chain.generate(request.question, reranked, {
      queryTime: Date.now() - pipelineStart,
      retrievalTime,
      rerankTime,
    });

    return response;
  }

  getBM25Manager(): BM25IndexManager {
    return this.bm25Manager;
  }
}

// Singleton for the API server
let _pipeline: RAGPipeline | null = null;

export function getPipeline(): RAGPipeline {
  if (!_pipeline) _pipeline = new RAGPipeline();
  return _pipeline;
}
