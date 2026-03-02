// Usage: npm run evaluate
// Exit code 0 = all thresholds passed, 1 = failed (blocks CI)

import "dotenv/config";
import fs from "fs/promises";
import { RAGEvaluator } from "../src/evaluation/evaluator.js";
import { getPipeline } from "../src/rag-pipeline.js";
import type { GoldenSample, EvalReport, EvalMetrics } from "../src/types/index.js";
import { logger } from "../src/api/logger.js";

async function main() {
  const datasetPath =
    process.env["EVAL_DATASET_PATH"] ?? "./data/eval/golden-dataset.json";
  const outputPath =
    process.env["EVAL_OUTPUT_PATH"] ?? "./data/eval/results.json";

  // Load golden dataset
  let samples: GoldenSample[];
  try {
    const raw = await fs.readFile(datasetPath, "utf-8");
    samples = JSON.parse(raw) as GoldenSample[];
    logger.info(`Loaded ${samples.length} evaluation samples`);
  } catch {
    logger.error(`Could not load dataset from ${datasetPath}`);
    logger.info(
      "Create a golden dataset at that path. See data/eval/golden-dataset.example.json"
    );
    process.exit(1);
  }

  // Initialize pipeline
  const pipeline = getPipeline();
  await pipeline.initialize();

  // Run evaluation
  const evaluator = new RAGEvaluator();
  const report = await evaluator.evaluateDataset(samples, (q) =>
    pipeline.query({ question: q })
  );

  // Save results
  await fs.mkdir("./data/eval", { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  // Print summary
  printReport(report);

  // Exit with failure if thresholds not met
  if (!report.overallPassed) {
    logger.error("Evaluation FAILED — thresholds not met");
    process.exit(1);
  } else {
    logger.info("Evaluation PASSED — all thresholds met");
    process.exit(0);
  }
}

function printReport(report: EvalReport) {
  console.log("\n" + "=".repeat(60));
  console.log("  RAG EVALUATION REPORT");
  console.log("=".repeat(60));
  console.log(`  Timestamp:     ${report.timestamp}`);
  console.log(`  Samples:       ${report.totalSamples}`);
  console.log(`  Passed:        ${report.passed} / ${report.totalSamples}`);
  console.log("\n  AVERAGE METRICS vs THRESHOLDS:");
  console.log("  " + "-".repeat(56));

  const fmt = (val: number, threshold: number) => {
    const pct = (val * 100).toFixed(1).padStart(5);
    const thr = (threshold * 100).toFixed(0);
    const ok = val >= threshold ? "✅" : "❌";
    return `${pct}% (threshold: ${thr}%) ${ok}`;
  };

  const m = report.averageMetrics;
  const t = report.thresholds;
  console.log(`  Faithfulness:      ${fmt(m.faithfulness, t.faithfulness)}`);
  console.log(
    `  Answer Relevancy:  ${fmt(m.answerRelevancy, t.answerRelevancy)}`
  );
  console.log(
    `  Context Precision: ${fmt(m.contextPrecision, t.contextPrecision)}`
  );
  console.log(
    `  Context Recall:    ${fmt(m.contextRecall, t.contextRecall)}`
  );
  console.log(
    "\n  OVERALL: " + (report.overallPassed ? "✅ PASSED" : "❌ FAILED")
  );
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  logger.error("Fatal error", { error: err });
  process.exit(1);
});
