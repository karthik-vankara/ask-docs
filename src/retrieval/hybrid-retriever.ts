import { OpenAIEmbeddings } from "@langchain/openai";
import { CloudClient, type Collection } from "chromadb";
import type {
  RetrievalResult,
  HybridRetrievalConfig,
  DocumentChunk,
  ChunkMetadata,
} from "../types/index.js";
import { BM25IndexManager } from "./bm25.js";
import { logger } from "../api/logger.js";

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

function reciprocalRankFusion(
  bm25Results: RetrievalResult[],
  vectorResults: RetrievalResult[],
  k: number = 60
): RetrievalResult[] {
  const scores = new Map<string, number>();
  const chunkMap = new Map<string, DocumentChunk>();

  bm25Results.forEach((result, rank) => {
    const contribution = 1 / (rank + k);
    scores.set(
      result.chunk.id,
      (scores.get(result.chunk.id) ?? 0) + contribution
    );
    chunkMap.set(result.chunk.id, result.chunk);
  });

  vectorResults.forEach((result, rank) => {
    const contribution = 1 / (rank + k);
    scores.set(
      result.chunk.id,
      (scores.get(result.chunk.id) ?? 0) + contribution
    );
    if (!chunkMap.has(result.chunk.id)) {
      chunkMap.set(result.chunk.id, result.chunk);
    }
  });

  return Array.from(scores.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([id, score]) => ({
      chunk: chunkMap.get(id)!,
      score,
      retrievalMethod: "hybrid" as const,
    }));
}

// ─── Hybrid Retriever ─────────────────────────────────────────────────────────

export class HybridRetriever {
  private embeddings: OpenAIEmbeddings;
  private chroma: CloudClient;
  private collection: Collection | null = null;
  private bm25Manager: BM25IndexManager;
  private config: HybridRetrievalConfig;

  constructor(
    bm25Manager: BM25IndexManager,
    config?: Partial<HybridRetrievalConfig>
  ) {
    this.config = {
      bm25TopK: 20,
      vectorTopK: 20,
      finalTopN: 10,
      rrfK: 60,
      ...config,
    };

    this.embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
    });

    this.chroma = new CloudClient({
      apiKey: process.env["CHROMA_API_KEY"] ?? "",
      tenant: process.env["CHROMA_TENANT"] ?? "",
      database: process.env["CHROMA_DATABASE"] ?? "ask-docs",
    });

    this.bm25Manager = bm25Manager;
  }

  async initialize(): Promise<void> {
    const collectionName =
      process.env["CHROMA_COLLECTION_NAME"] ?? "ask-my-docs";
    this.collection = await this.chroma.getOrCreateCollection({
      name: collectionName,
    });
    logger.info("HybridRetriever initialized");
  }

  async retrieve(query: string): Promise<RetrievalResult[]> {
    const start = Date.now();

    // 1. BM25 retrieval (keyword-based)
    const bm25Results = this.bm25Manager.search(query, this.config.bm25TopK);
    logger.debug("BM25 retrieved", { count: bm25Results.length });

    // 2. Vector retrieval (semantic)
    if (!this.collection) throw new Error("Collection not initialized");

    const queryEmbedding = await this.embeddings.embedQuery(query);
    const vectorResponse = await this.collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: this.config.vectorTopK,
      include: ["documents", "metadatas", "distances"] as any,
    });

    const vectorResults: RetrievalResult[] = (
      vectorResponse.ids[0] ?? []
    ).map((id, i) => {
      const rawMeta = vectorResponse.metadatas?.[0]?.[i] ?? {};
      const metadata: ChunkMetadata = {
        source: String(rawMeta["source"] ?? ""),
        fileName: String(rawMeta["fileName"] ?? ""),
        chunkIndex: Number(rawMeta["chunkIndex"] ?? 0),
        totalChunks: Number(rawMeta["totalChunks"] ?? 0),
        ingestedAt: String(rawMeta["ingestedAt"] ?? ""),
        pageNumber:
          rawMeta["pageNumber"] != null
            ? Number(rawMeta["pageNumber"])
            : undefined,
      };

      return {
        chunk: {
          id,
          text: vectorResponse.documents?.[0]?.[i] ?? "",
          metadata,
        },
        score: 1 - (vectorResponse.distances?.[0]?.[i] ?? 1),
        retrievalMethod: "vector" as const,
      };
    });

    logger.debug("Vector retrieved", { count: vectorResults.length });

    // 3. Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(
      bm25Results,
      vectorResults,
      this.config.rrfK
    );

    const final = fused.slice(0, this.config.finalTopN);

    logger.info("Hybrid retrieval complete", {
      bm25: bm25Results.length,
      vector: vectorResults.length,
      fused: fused.length,
      returned: final.length,
      ms: Date.now() - start,
    });

    return final;
  }
}
