/**
 * Express API Server with Langfuse Tracing
 * 
 * CRITICAL: 
 * 1. dotenv/config must be loaded FIRST 
 * 2. observability-init.ts must be imported SECOND (needs environment variables)
 * 3. Everything else comes after
 */

// ─── Load Environment Variables FIRST ──────────────────────────────────────────
import "dotenv/config";

// ─── Initialize OpenTelemetry & Langfuse ──────────────────────────────────────
import "../observability-init.js";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import os from "os";
import asyncHandler from "express-async-handler";
import { z } from "zod";
import { getPipeline } from "../rag-pipeline.js";
import { DocumentIngester } from "../ingestion/ingester.js";
import type { QueryResponse, IngestResponse } from "../types/index.js";
import { logger } from "./logger.js";
import { startActiveObservation, updateActiveTrace } from "../observability.js";

const app = express();
const upload = multer({ dest: "./data/uploads/" });


// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet());
app.use(cors());
app.use(express.json());

// API Key auth (skip for health check)
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const key = req.headers["x-api-key"];
  if (process.env["API_KEY"] && key !== process.env["API_KEY"]) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
});

// ─── Request Schemas ──────────────────────────────────────────────────────────

const QuerySchema = z.object({
  question: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(20).optional(),
  streaming: z.boolean().optional().default(false),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Query endpoint
app.post(
  "/query",
  asyncHandler(async (req, res) => {
    const parsed = QuerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors });
      return;
    }

    const { question } = parsed.data;
    // Use hostname as default userId if not provided in headers
    const userId = (req.headers["x-user-id"] as string | undefined) || os.hostname();

    try {
      // Wrap query execution with Langfuse tracing
      await startActiveObservation(
        "rag-query",
        async (span) => {
          // Set trace-level attributes (userId, sessionId, etc.)
          updateActiveTrace({ userId });

          // Set input on span
          span.update({
            input: { question, topK: parsed.data.topK },
          });

          try {
            const pipeline = getPipeline();
            const response = await pipeline.query({
              question,
              topK: parsed.data.topK,
            });

            // Update span with answer and cost metadata
            // Langfuse will read these from the OpenTelemetry span attributes
            span.update({
              output: response.answer,
              metadata: {
                model: response.metadata.model,
                retrievedChunks: response.metadata.chunksAfterRerank,
                citations: response.citations.length,
                // Token and cost tracking for Langfuse
                inputTokens: response.metadata.inputTokens,
                outputTokens: response.metadata.outputTokens,
                totalTokens: response.metadata.totalTokens,
                estimatedCostUsd: response.metadata.estimatedCostUsd,
              },
            });

            logger.info("Query traced successfully", {
              userId,
              model: response.metadata.model,
              tokens: response.metadata.totalTokens,
            });

            const result: QueryResponse = { success: true, data: response };
            res.json(result);
          } catch (innerError) {
            logger.error("Pipeline query error", { error: innerError });
            throw innerError;
          }
        }
      );
    } catch (error) {
      logger.error("Query error", { error });
      throw error;
    }
  })
);

// Upload & ingest files
app.post(
  "/ingest",
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files provided" });
      return;
    }

    const ingester = new DocumentIngester();
    await ingester.initialize();

    const results = [];
    for (const file of files) {
      const originalPath = file.path + path.extname(file.originalname);
      await fs.rename(file.path, originalPath);

      const result = await ingester.ingestFile(originalPath);
      results.push(result);
    }

    const response: IngestResponse = { success: true, results };
    res.json(response);
  })
);

// Ingest server-side directory
app.post(
  "/ingest/directory",
  asyncHandler(async (req, res) => {
    const { dirPath } = req.body as { dirPath?: string };
    if (!dirPath) {
      res.status(400).json({ error: "dirPath is required" });
      return;
    }

    const ingester = new DocumentIngester();
    await ingester.initialize();

    const results = await ingester.ingestDirectory(dirPath);
    const response: IngestResponse = { success: true, results };
    res.json(response);
  })
);

// Stats endpoint
app.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const pipeline = getPipeline();
    await pipeline.initialize();
    const bm25Count = pipeline.getBM25Manager().documentCount;
    res.json({
      bm25DocumentCount: bm25Count,
      timestamp: new Date().toISOString(),
    });
  })
);

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, error: "Internal server error" });
  }
);

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  logger.info(`Ask My Docs API running on ${HOST}:${PORT}`);
  logger.info(`Health: http://${HOST}:${PORT}/health`);
  const langfuseEnabled = !!(process.env["LANGFUSE_SECRET_KEY"] && process.env["LANGFUSE_PUBLIC_KEY"]);
  logger.info(`Monitoring: ${langfuseEnabled ? "Langfuse enabled" : "Langfuse disabled (no credentials)"}`);
  logger.debug("Environment variables", {
    port: PORT,
    host: HOST,
    chromaKey: !!process.env["CHROMA_API_KEY"],
    openaiKey: !!process.env["OPENAI_API_KEY"],
    langfuseEnabled,
  });
});

// Graceful shutdown: SDK handles flushing in observability-init.ts
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down...");
  server.close();
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down...");
  server.close();
});

export default app;
