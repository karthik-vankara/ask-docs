import OpenAI from "openai";
import type {
  RerankResult,
  RAGResponse,
  Citation,
  ResponseMetadata,
} from "../types/index.js";
import { logger } from "../api/logger.js";

// ─── Citation Parser ──────────────────────────────────────────────────────────

function parseCitations(
  answer: string,
  chunks: RerankResult[]
): { cleanAnswer: string; citations: Citation[] } {
  const referencedIds = new Set<number>();
  const citationRegex = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationRegex.exec(answer)) !== null) {
    const id = parseInt(match[1]!, 10);
    if (id >= 1 && id <= chunks.length) {
      referencedIds.add(id);
    }
  }

  const citations: Citation[] = Array.from(referencedIds)
    .sort((a, b) => a - b)
    .map((id) => {
      const chunk = chunks[id - 1]!;
      return {
        id,
        source: chunk.chunk.metadata.source,
        fileName: chunk.chunk.metadata.fileName,
        pageNumber: chunk.chunk.metadata.pageNumber,
        text: chunk.chunk.text,
      };
    });

  return { cleanAnswer: answer, citations };
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a precise document assistant. Your job is to answer questions using ONLY the provided context chunks.

STRICT RULES:
1. Every factual claim MUST be followed by a citation like [1], [2], etc., referring to the context chunk number.
2. If multiple chunks support a claim, cite all of them: [1][3].
3. If the answer cannot be found in the provided context, respond ONLY with: "I don't have enough information in the provided documents to answer this question."
4. Never fabricate information or draw on knowledge outside the provided context.
5. Be concise and direct. Do not repeat information unnecessarily.
6. Use clear, professional language.`;
}

function buildUserPrompt(question: string, chunks: RerankResult[]): string {
  const contextSection = chunks
    .map(
      (r, i) =>
        `[${i + 1}] Source: ${r.chunk.metadata.fileName}${
          r.chunk.metadata.pageNumber
            ? ` (page ${r.chunk.metadata.pageNumber})`
            : ""
        }\n${r.chunk.text}`
    )
    .join("\n\n---\n\n");

  return `CONTEXT CHUNKS:\n${contextSection}\n\n---\n\nQUESTION: ${question}\n\nProvide a thorough answer with citations [N] for every claim.`;
}

// ─── RAG Chain ────────────────────────────────────────────────────────────────

export class RAGChain {
  private openai: OpenAI;
  private model: string;

  constructor(model: string = "gpt-4o-mini") {
    this.openai = new OpenAI({
      apiKey: process.env["OPENAI_API_KEY"],
    });
    this.model = model;
  }

  async generate(
    question: string,
    rerankedChunks: RerankResult[],
    timings: Omit<
      ResponseMetadata,
      | "generationTime"
      | "totalTime"
      | "model"
      | "chunksRetrieved"
      | "chunksAfterRerank"
    >
  ): Promise<RAGResponse> {
    if (rerankedChunks.length === 0) {
      return {
        answer:
          "I don't have any relevant documents to answer this question.",
        citations: [],
        retrievedChunks: [],
        metadata: {
          ...timings,
          generationTime: 0,
          totalTime: 0,
          model: this.model,
          chunksRetrieved: 0,
          chunksAfterRerank: 0,
        },
      };
    }

    const genStart = Date.now();

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(question, rerankedChunks) },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    });

    const rawAnswer = response.choices[0]?.message.content ?? "";
    const generationTime = Date.now() - genStart;

    // ─── Capture and track token usage & costs ─────────────────────────────
    // Extract usage metrics from OpenAI response for cost tracking
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? 0;

    // Calculate estimated cost (GPT-4o-mini pricing as of March 2026)
    // Input: $0.15 per 1M tokens, Output: $0.60 per 1M tokens
    const inputCost = inputTokens * (0.15 / 1_000_000);
    const outputCost = outputTokens * (0.60 / 1_000_000);
    const totalCost = inputCost + outputCost;

    logger.info("Generation complete", {
      model: this.model,
      ms: generationTime,
      tokens: {
        prompt: inputTokens,
        completion: outputTokens,
        total: totalTokens,
      },
      cost_usd: totalCost.toFixed(6),
    });

    const { cleanAnswer, citations } = parseCitations(
      rawAnswer,
      rerankedChunks
    );

    const totalTime =
      timings.queryTime +
      timings.retrievalTime +
      timings.rerankTime +
      generationTime;

    return {
      answer: cleanAnswer,
      citations,
      retrievedChunks: rerankedChunks,
      metadata: {
        ...timings,
        generationTime,
        totalTime,
        model: this.model,
        chunksRetrieved: rerankedChunks.length,
        chunksAfterRerank: rerankedChunks.length,
        // Include token usage and cost for Langfuse tracking
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostUsd: totalCost,
      },
    };
  }

  // Streaming version for real-time responses
  async *generateStream(
    question: string,
    rerankedChunks: RerankResult[]
  ): AsyncGenerator<string> {
    const stream = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(question, rerankedChunks) },
      ],
      temperature: 0.1,
      max_tokens: 1024,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content ?? "";
      if (delta) yield delta;
    }
  }
}
