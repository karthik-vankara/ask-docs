import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { OpenAIEmbeddings } from "@langchain/openai";
import { CloudClient, type Collection } from "chromadb";
import type {
  DocumentChunk,
  ChunkMetadata,
  IngestionResult,
  IngestionConfig,
} from "../types/index.js";
import { BM25IndexManager } from "../retrieval/bm25.js";
import { logger } from "../api/logger.js";

// ─── Text Chunker ─────────────────────────────────────────────────────────────

function chunkText(text: string, config: IngestionConfig): string[] {
  const { chunkSize, chunkOverlap, separators } = config;
  const chunks: string[] = [];

  // Try splitting by each separator in priority order
  let segments = [text];
  for (const sep of separators) {
    if (segments.length === 1 && segments[0]!.length > chunkSize) {
      segments = segments[0]!.split(sep).filter((s) => s.trim().length > 0);
    }
  }

  let current = "";
  for (const segment of segments) {
    if ((current + segment).length <= chunkSize) {
      current += (current ? " " : "") + segment;
    } else {
      if (current.trim()) chunks.push(current.trim());
      const overlap = current.slice(-chunkOverlap);
      current = overlap + (overlap ? " " : "") + segment;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length > 50);
}

// ─── File Loaders ─────────────────────────────────────────────────────────────

async function loadPDF(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

async function loadText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

async function loadDocument(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return loadPDF(filePath);
    case ".md":
    case ".mdx":
    case ".txt":
      return loadText(filePath);
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

// ─── Main Ingester ────────────────────────────────────────────────────────────

export class DocumentIngester {
  private embeddings: OpenAIEmbeddings;
  private chroma: CloudClient;
  private collection: Collection | null = null;
  private bm25Manager: BM25IndexManager;
  private config: IngestionConfig;

  constructor(config?: Partial<IngestionConfig>) {
    this.config = {
      chunkSize: 512,
      chunkOverlap: 50,
      separators: ["\n\n", "\n", ". ", " "],
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

    this.bm25Manager = new BM25IndexManager(
      process.env["BM25_INDEX_PATH"] ?? "./data/bm25-index.json"
    );
  }

  async initialize(): Promise<void> {
    const collectionName =
      process.env["CHROMA_COLLECTION_NAME"] ?? "ask-my-docs";

    this.collection = await this.chroma.getOrCreateCollection({
      name: collectionName,
      metadata: { "hnsw:space": "cosine" },
    });

    await this.bm25Manager.load();
    logger.info("Ingester initialized", { collection: collectionName });
  }

  async ingestFile(filePath: string): Promise<IngestionResult> {
    logger.info("Ingesting file", { filePath });

    try {
      // 1. Load document text
      const rawText = await loadDocument(filePath);
      const fileName = path.basename(filePath);

      // 2. Chunk the text
      const textChunks = chunkText(rawText, this.config);
      logger.info(`Created ${textChunks.length} chunks`, { fileName });

      // 3. Build DocumentChunk objects with metadata
      const chunks: DocumentChunk[] = textChunks.map((text, i) => ({
        id: uuidv4(),
        text,
        metadata: {
          source: filePath,
          fileName,
          chunkIndex: i,
          totalChunks: textChunks.length,
          ingestedAt: new Date().toISOString(),
        } satisfies ChunkMetadata,
      }));

      // 4. Generate embeddings in batches
      const batchSize = 100;
      const allEmbeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchTexts = batch.map((c) => c.text);
        const batchEmbeddings =
          await this.embeddings.embedDocuments(batchTexts);
        allEmbeddings.push(...batchEmbeddings);
      }

      // 5. Store in ChromaDB
      if (!this.collection) throw new Error("Collection not initialized");
      await this.collection.add({
        ids: chunks.map((c) => c.id),
        embeddings: allEmbeddings,
        documents: chunks.map((c) => c.text),
        metadatas: chunks.map((c) => ({
          source: c.metadata.source,
          fileName: c.metadata.fileName,
          chunkIndex: c.metadata.chunkIndex,
          totalChunks: c.metadata.totalChunks,
          ingestedAt: c.metadata.ingestedAt,
        })),
      });

      // 6. Add to BM25 index
      for (const chunk of chunks) {
        this.bm25Manager.addDocument(chunk);
      }
      await this.bm25Manager.save();

      logger.info("File ingested successfully", {
        fileName,
        chunks: chunks.length,
      });

      return { success: true, fileName, chunksCreated: chunks.length };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Ingestion failed", { filePath, error: msg });
      return {
        success: false,
        fileName: path.basename(filePath),
        chunksCreated: 0,
        errors: [msg],
      };
    }
  }

  async ingestDirectory(dirPath: string): Promise<IngestionResult[]> {
    const files = await fs.readdir(dirPath);
    const supported = files.filter((f) =>
      [".pdf", ".md", ".txt", ".mdx"].includes(path.extname(f).toLowerCase())
    );

    const results: IngestionResult[] = [];
    for (const file of supported) {
      const result = await this.ingestFile(path.join(dirPath, file));
      results.push(result);
    }
    return results;
  }
}
