// Usage: npm run ingest -- ./data/docs
// Or:    npm run ingest -- ./data/docs/my-file.pdf

import "dotenv/config";
import path from "path";
import fs from "fs/promises";
import { DocumentIngester } from "../src/ingestion/ingester.js";
import { logger } from "../src/api/logger.js";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run ingest -- <file-or-directory>");
    process.exit(1);
  }

  const ingester = new DocumentIngester();
  await ingester.initialize();

  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    logger.info(`Ingesting directory: ${target}`);
    const results = await ingester.ingestDirectory(target);
    const total = results.reduce((s, r) => s + r.chunksCreated, 0);
    const failures = results.filter((r) => !r.success);
    logger.info(
      `Done. Files: ${results.length}, Chunks: ${total}, Failures: ${failures.length}`
    );
    if (failures.length > 0) {
      failures.forEach((f) =>
        logger.error(`Failed: ${f.fileName}`, { errors: f.errors })
      );
    }
  } else {
    logger.info(`Ingesting file: ${path.basename(target)}`);
    const result = await ingester.ingestFile(target);
    if (result.success) {
      logger.info(`Done. Chunks created: ${result.chunksCreated}`);
    } else {
      logger.error("Ingestion failed", { errors: result.errors });
      process.exit(1);
    }
  }
}

main().catch((err) => {
  logger.error("Fatal error", { error: err });
  process.exit(1);
});
