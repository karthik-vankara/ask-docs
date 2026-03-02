import fs from "fs/promises";
import type {
  DocumentChunk,
  BM25Index,
  BM25Document,
  RetrievalResult,
} from "../types/index.js";
import { logger } from "../api/logger.js";

// ─── BM25 Okapi Constants ─────────────────────────────────────────────────────

const K1 = 1.5; // term frequency saturation
const B = 0.75; // length normalization

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function computeIDF(
  docFrequency: number,
  totalDocs: number
): number {
  return Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));
}

// ─── BM25 Index Manager ───────────────────────────────────────────────────────

export class BM25IndexManager {
  private indexPath: string;
  private documents: BM25Document[] = [];
  private idf: Record<string, number> = {};
  private avgDocLength = 0;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf-8");
      const index = JSON.parse(raw) as BM25Index;
      this.documents = index.documents;
      this.idf = index.idf;
      this.avgDocLength = index.avgDocLength;
      logger.info("BM25 index loaded", { documents: this.documents.length });
    } catch {
      logger.info("No existing BM25 index, starting fresh");
      this.documents = [];
      this.idf = {};
      this.avgDocLength = 0;
    }
  }

  addDocument(chunk: DocumentChunk): void {
    const tokens = tokenize(chunk.text);
    this.documents.push({
      id: chunk.id,
      tokens,
      metadata: chunk.metadata,
      text: chunk.text,
    });
    this.rebuildIDF();
  }

  private rebuildIDF(): void {
    const totalDocs = this.documents.length;
    if (totalDocs === 0) return;

    const df: Record<string, number> = {};
    let totalLength = 0;

    for (const doc of this.documents) {
      const seen = new Set<string>();
      totalLength += doc.tokens.length;
      for (const token of doc.tokens) {
        if (!seen.has(token)) {
          df[token] = (df[token] ?? 0) + 1;
          seen.add(token);
        }
      }
    }

    this.avgDocLength = totalLength / totalDocs;

    this.idf = {};
    for (const [term, freq] of Object.entries(df)) {
      this.idf[term] = computeIDF(freq, totalDocs);
    }
  }

  async save(): Promise<void> {
    const dir = this.indexPath.split("/").slice(0, -1).join("/");
    if (dir) await fs.mkdir(dir, { recursive: true });

    const index: BM25Index = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      documents: this.documents,
      idf: this.idf,
      avgDocLength: this.avgDocLength,
    };
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
    logger.info("BM25 index saved", { documents: this.documents.length });
  }

  search(query: string, topK: number): RetrievalResult[] {
    if (this.documents.length === 0) return [];

    const queryTokens = tokenize(query);
    const scores: Array<{ docIndex: number; score: number }> = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i]!;
      let score = 0;
      const docLength = doc.tokens.length;

      for (const queryToken of queryTokens) {
        const idfScore = this.idf[queryToken] ?? 0;
        if (idfScore === 0) continue;

        const tf = doc.tokens.filter((t) => t === queryToken).length;
        if (tf === 0) continue;

        // BM25 Okapi formula
        const numerator = tf * (K1 + 1);
        const denominator =
          tf + K1 * (1 - B + B * (docLength / this.avgDocLength));
        score += idfScore * (numerator / denominator);
      }

      if (score > 0) scores.push({ docIndex: i, score });
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map(({ docIndex, score }) => {
      const doc = this.documents[docIndex]!;
      return {
        chunk: {
          id: doc.id,
          text: doc.text,
          metadata: doc.metadata,
        },
        score,
        retrievalMethod: "bm25" as const,
      };
    });
  }

  get documentCount(): number {
    return this.documents.length;
  }
}
