import OpenAI from "openai";
import type {
  GoldenSample,
  EvalMetrics,
  EvalResult,
  EvalReport,
  RAGResponse,
} from "../types/index.js";
import { logger } from "../api/logger.js";

// ─── LLM Judge Prompts ────────────────────────────────────────────────────────

const FAITHFULNESS_PROMPT = (answer: string, context: string) => `
You are evaluating whether an AI assistant's answer is faithful to the provided context.
Faithful means: every claim in the answer is directly supported by the context. No hallucinations.

Context:
${context}

Answer to evaluate:
${answer}

Score the faithfulness from 0.0 to 1.0 where:
- 1.0 = every claim is fully supported by context
- 0.5 = some claims supported, some not
- 0.0 = answer contradicts or ignores context

Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}
`;

const ANSWER_RELEVANCY_PROMPT = (question: string, answer: string) => `
You are evaluating whether an AI assistant's answer is relevant to the question asked.

Question: ${question}
Answer: ${answer}

Score the answer relevancy from 0.0 to 1.0 where:
- 1.0 = answer directly and completely addresses the question
- 0.5 = answer partially addresses the question
- 0.0 = answer does not address the question at all

Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}
`;

const CONTEXT_PRECISION_PROMPT = (question: string, contexts: string[]) => `
You are evaluating whether the retrieved context chunks are relevant to the question.

Question: ${question}

Retrieved chunks:
${contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}

Score the context precision from 0.0 to 1.0 where:
- 1.0 = all retrieved chunks are highly relevant to the question
- 0.5 = roughly half the chunks are relevant
- 0.0 = none of the chunks are relevant to the question

Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}
`;

const CONTEXT_RECALL_PROMPT = (groundTruth: string, contexts: string[]) => `
You are evaluating whether the retrieved context contains the information needed to answer the question.

Ground truth answer (what we expect):
${groundTruth}

Retrieved chunks:
${contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}

Score the context recall from 0.0 to 1.0 where:
- 1.0 = the retrieved chunks contain all information needed for the ground truth answer
- 0.5 = the retrieved chunks contain some but not all needed information
- 0.0 = the retrieved chunks contain none of the needed information

Respond with ONLY a JSON object: {"score": <number>, "reason": "<brief reason>"}
`;

// ─── LLM Judge Helper ─────────────────────────────────────────────────────────

async function judgeWithLLM(prompt: string, openai: OpenAI): Promise<number> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 150,
    });

    const raw = response.choices[0]?.message.content ?? "{}";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { score: number };
    return Math.max(0, Math.min(1, parsed.score));
  } catch (error) {
    logger.warn("LLM judge failed", { error });
    return 0;
  }
}

// ─── Main Evaluator ───────────────────────────────────────────────────────────

export class RAGEvaluator {
  private openai: OpenAI;
  private thresholds: EvalMetrics;

  constructor(thresholds?: Partial<EvalMetrics>) {
    this.openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
    this.thresholds = {
      faithfulness: parseFloat(
        process.env["FAITHFULNESS_THRESHOLD"] ?? "0.85"
      ),
      answerRelevancy: parseFloat(
        process.env["ANSWER_RELEVANCY_THRESHOLD"] ?? "0.80"
      ),
      contextPrecision: parseFloat(
        process.env["CONTEXT_PRECISION_THRESHOLD"] ?? "0.75"
      ),
      contextRecall: parseFloat(
        process.env["CONTEXT_RECALL_THRESHOLD"] ?? "0.70"
      ),
      ...thresholds,
    };
  }

  async evaluateSample(
    sample: GoldenSample,
    ragResponse: RAGResponse
  ): Promise<EvalResult> {
    const contextTexts = ragResponse.retrievedChunks.map((r) => r.chunk.text);
    const contextString = contextTexts.join("\n\n");

    // Run all 4 metrics in parallel
    const [faithfulness, answerRelevancy, contextPrecision, contextRecall] =
      await Promise.all([
        judgeWithLLM(
          FAITHFULNESS_PROMPT(ragResponse.answer, contextString),
          this.openai
        ),
        judgeWithLLM(
          ANSWER_RELEVANCY_PROMPT(sample.question, ragResponse.answer),
          this.openai
        ),
        judgeWithLLM(
          CONTEXT_PRECISION_PROMPT(sample.question, contextTexts),
          this.openai
        ),
        judgeWithLLM(
          CONTEXT_RECALL_PROMPT(sample.groundTruthAnswer, contextTexts),
          this.openai
        ),
      ]);

    const metrics: EvalMetrics = {
      faithfulness,
      answerRelevancy,
      contextPrecision,
      contextRecall,
    };

    const passed =
      faithfulness >= this.thresholds.faithfulness &&
      answerRelevancy >= this.thresholds.answerRelevancy &&
      contextPrecision >= this.thresholds.contextPrecision &&
      contextRecall >= this.thresholds.contextRecall;

    logger.info("Sample evaluated", {
      id: sample.id,
      passed,
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([k, v]) => [k, v.toFixed(3)])
      ),
    });

    return {
      sampleId: sample.id,
      question: sample.question,
      generatedAnswer: ragResponse.answer,
      groundTruthAnswer: sample.groundTruthAnswer,
      metrics,
      citations: ragResponse.citations,
      passed,
    };
  }

  async evaluateDataset(
    samples: GoldenSample[],
    queryFn: (question: string) => Promise<RAGResponse>
  ): Promise<EvalReport> {
    logger.info(`Starting evaluation on ${samples.length} samples`);

    const results: EvalResult[] = [];
    for (const sample of samples) {
      const ragResponse = await queryFn(sample.question);
      const result = await this.evaluateSample(sample, ragResponse);
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const avg = (key: keyof EvalMetrics) =>
      results.reduce((sum, r) => sum + r.metrics[key], 0) / results.length;

    const averageMetrics: EvalMetrics = {
      faithfulness: avg("faithfulness"),
      answerRelevancy: avg("answerRelevancy"),
      contextPrecision: avg("contextPrecision"),
      contextRecall: avg("contextRecall"),
    };

    const overallPassed =
      averageMetrics.faithfulness >= this.thresholds.faithfulness &&
      averageMetrics.answerRelevancy >= this.thresholds.answerRelevancy &&
      averageMetrics.contextPrecision >= this.thresholds.contextPrecision &&
      averageMetrics.contextRecall >= this.thresholds.contextRecall;

    return {
      timestamp: new Date().toISOString(),
      totalSamples: samples.length,
      passed,
      failed: samples.length - passed,
      averageMetrics,
      thresholds: this.thresholds,
      results,
      overallPassed,
    };
  }
}
