import { CohereClient } from "cohere-ai";
import type { RetrievalResult, RerankResult } from "../types/index.js";
import { logger } from "../api/logger.js";

// ─── Cohere Cross-Encoder Reranker ────────────────────────────────────────────

export class CrossEncoderReranker {
  private cohere: CohereClient;
  private model: string;
  private topN: number;

  constructor(topN: number = 5, model: string = "rerank-english-v3.0") {
    this.cohere = new CohereClient({
      token: process.env["COHERE_API_KEY"] ?? "",
    });
    this.model = model;
    this.topN = topN;
  }

  async rerank(
    query: string,
    candidates: RetrievalResult[]
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const start = Date.now();

    try {
      const documents = candidates.map((c) => c.chunk.text);

      const response = await this.cohere.rerank({
        query,
        documents,
        topN: Math.min(this.topN, candidates.length),
        model: this.model,
        returnDocuments: false,
      });

      const results: RerankResult[] = response.results.map((r, rank) => {
        const original = candidates[r.index]!;
        return {
          chunk: original.chunk,
          originalScore: original.score,
          rerankScore: r.relevanceScore,
          rank,
        };
      });

      logger.info("Reranking complete", {
        input: candidates.length,
        output: results.length,
        ms: Date.now() - start,
        topScore: results[0]?.rerankScore.toFixed(3),
      });

      return results;
    } catch (error) {
      // Fallback: return original order if Cohere fails
      logger.error("Reranking failed, using original order", { error });
      return candidates.slice(0, this.topN).map((c, rank) => ({
        chunk: c.chunk,
        originalScore: c.score,
        rerankScore: c.score,
        rank,
      }));
    }
  }
}

// ─── Local Fallback Reranker (no API required) ────────────────────────────────

export class LocalReranker {
  private topN: number;

  constructor(topN: number = 5) {
    this.topN = topN;
  }

  rerank(query: string, candidates: RetrievalResult[]): RerankResult[] {
    const queryTerms = new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );

    const scored = candidates.map((candidate) => {
      const chunkTerms = candidate.chunk.text.toLowerCase().split(/\s+/);
      let overlap = 0;
      for (const term of queryTerms) {
        if (chunkTerms.includes(term)) overlap++;
      }
      const localScore =
        candidate.score * 0.4 +
        (overlap / Math.max(queryTerms.size, 1)) * 0.6;
      return { candidate, localScore };
    });

    scored.sort((a, b) => b.localScore - a.localScore);

    return scored
      .slice(0, this.topN)
      .map(({ candidate, localScore }, rank) => ({
        chunk: candidate.chunk,
        originalScore: candidate.score,
        rerankScore: localScore,
        rank,
      }));
  }
}
