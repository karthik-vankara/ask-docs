import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import asyncHandler from "express-async-handler";
import { z } from "zod";
import { getPipeline } from "../rag-pipeline.js";
import { DocumentIngester } from "../ingestion/ingester.js";
import type { QueryResponse, IngestResponse } from "../types/index.js";
import { logger } from "./logger.js";

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

    const pipeline = getPipeline();
    const response = await pipeline.query({
      question,
      topK: parsed.data.topK,
    });

    const result: QueryResponse = { success: true, data: response };
    res.json(result);
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
app.listen(PORT, () => {
  logger.info(`Ask My Docs API running on port ${PORT}`);
  logger.info(`Health: http://localhost:${PORT}/health`);
});

export default app;
