# Ask My Docs — Production RAG Application

A production-grade, domain-specific document Q&A system built with TypeScript. It combines **hybrid retrieval** (BM25 keyword search + vector semantic search), **cross-encoder reranking** via Cohere, **strict citation enforcement** in every answer, and a **CI-gated evaluation pipeline** that blocks merges when quality drops.

This is the most common pattern used in enterprise AI systems today.

---

## Table of Contents

- [Architecture Deep Dive](#architecture-deep-dive)
  - [Pipeline Overview](#pipeline-overview)
  - [Stage 1: Document Ingestion](#stage-1-document-ingestion)
  - [Stage 2: Hybrid Retrieval](#stage-2-hybrid-retrieval)
  - [Stage 3: Cross-Encoder Reranking](#stage-3-cross-encoder-reranking)
  - [Stage 4: Citation-Enforced Generation](#stage-4-citation-enforced-generation)
  - [Stage 5: Evaluation Pipeline](#stage-5-evaluation-pipeline)
- [Project Structure](#project-structure)
- [Technology Stack](#technology-stack)
- [Setup & Installation](#setup--installation)
  - [Prerequisites](#prerequisites)
  - [Step 1: Clone & Install](#step-1-clone--install)
  - [Step 2: Configure Environment](#step-2-configure-environment)
  - [Step 3: Ingest Documents](#step-3-ingest-documents)
  - [Step 4: Start the API Server](#step-4-start-the-api-server)
  - [Step 5: Start the Frontend](#step-5-start-the-frontend)
- [API Reference](#api-reference)
- [Testing & Evaluation Strategy](#testing--evaluation-strategy)
  - [Evaluation Metrics Explained](#evaluation-metrics-explained)
  - [Creating a Golden Dataset](#creating-a-golden-dataset)
  - [Running Evaluation Locally](#running-evaluation-locally)
  - [CI/CD Quality Gate](#cicd-quality-gate)
  - [Example: Full Evaluation Run](#example-full-evaluation-run)
- [Configuration & Customization](#configuration--customization)

---

## Architecture Deep Dive

### Pipeline Overview

Every user question flows through a four-stage pipeline. Each stage is isolated, testable, and swappable.

```
                    ┌──────────────────┐
                    │   User Question  │
                    └────────┬─────────┘
                             │
              ┌──────────────▼──────────────┐
              │       HYBRID RETRIEVAL       │
              │                              │
              │  ┌────────┐   ┌───────────┐ │
              │  │  BM25   │   │  Vector   │ │
              │  │ keyword │   │ semantic  │ │
              │  │ top-20  │   │  top-20   │ │
              │  └────┬────┘   └─────┬─────┘ │
              │       │   RRF Fusion │       │
              │       └──────┬───────┘       │
              │         top-10 fused         │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │    CROSS-ENCODER RERANKING   │
              │    Cohere rerank-english-v3  │
              │         top-5 output         │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │   CITATION-ENFORCED LLM      │
              │   GPT-4o-mini + system       │
              │   prompt requiring [N] refs   │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Answer + [1][2]  │
                    │   Citations       │
                    └──────────────────┘
```

### Stage 1: Document Ingestion

**File:** `src/ingestion/ingester.ts`

When you upload a document (PDF, Markdown, or plain text), the ingester:

1. **Loads** the file using format-specific loaders (`pdf-parse` for PDFs, raw `fs.readFile` for `.md`/`.txt`)
2. **Chunks** the text into ~512-character segments with 50-character overlap. Chunking uses a priority separator strategy: it first tries `\n\n` (paragraphs), then `\n` (lines), then `. ` (sentences), then spaces. This preserves semantic coherence within chunks.
3. **Generates embeddings** using OpenAI's `text-embedding-3-small` model (1536 dimensions). Embeddings are generated in batches of 100 for efficiency.
4. **Dual-indexes** every chunk into:
   - **ChromaDB** (vector store) — stores the embedding + text + metadata for semantic similarity search
   - **BM25 index** (JSON file on disk) — stores tokenized text for keyword-based retrieval

This dual-indexing is what enables hybrid retrieval: you search both stores independently, then fuse the results.

```
Document (PDF/MD/TXT)
    │
    ▼
┌─────────────────┐
│  Text Extraction │  ← pdf-parse or fs.readFile
└────────┬────────┘
         ▼
┌─────────────────┐
│   Chunking       │  ← 512 chars, 50 overlap
│   (recursive     │     separators: ¶ → \n → . → space
│    splitting)    │
└────────┬────────┘
         ▼
┌─────────────────────────────────────┐
│   For each chunk:                    │
│   ├── Generate embedding (OpenAI)    │
│   ├── Store in ChromaDB (vector)     │
│   └── Store in BM25 index (keyword)  │
└─────────────────────────────────────┘
```

**Why dual indexing?** Vector search excels at finding semantically similar content ("authentication" matches "login process"), while BM25 excels at exact keyword matches ("API_KEY" or "rate_limit"). Combining both catches what either alone would miss.

### Stage 2: Hybrid Retrieval

**Files:** `src/retrieval/bm25.ts`, `src/retrieval/hybrid-retriever.ts`

When a query arrives, two parallel retrieval paths execute:

**BM25 Retrieval** (`bm25.ts`): A pure TypeScript implementation of the BM25 Okapi algorithm — the same algorithm behind Elasticsearch's default scoring. It:
- Tokenizes the query (lowercase, strip punctuation, remove 1-char tokens)
- Computes IDF (inverse document frequency) for each query term
- Scores every document using the BM25 formula: `IDF × (tf × (k1+1)) / (tf + k1 × (1 - b + b × dl/avgdl))`
  - `k1 = 1.5` controls term frequency saturation
  - `b = 0.75` controls length normalization
- Returns the top-20 results sorted by score

**Vector Retrieval** (`hybrid-retriever.ts`): Embeds the query using the same OpenAI model, then queries ChromaDB for the top-20 nearest neighbors by cosine similarity.

**Reciprocal Rank Fusion (RRF):** The two ranked lists are fused using the formula:

$$\text{RRF}(d) = \sum_{r \in \text{rankers}} \frac{1}{k + \text{rank}_r(d)}$$

Where $k = 60$ (standard constant). This produces a single ranked list that balances both retrieval methods. The top-10 fused results are passed to reranking.

**Why RRF over simple score averaging?** RRF is rank-based, not score-based, so it doesn't require normalizing scores across different systems. A document ranked #1 by BM25 and #5 by vector search will rank higher than one ranked #3 by both.

### Stage 3: Cross-Encoder Reranking

**File:** `src/reranking/reranker.ts`

The top-10 hybrid results are reranked using Cohere's `rerank-english-v3.0` cross-encoder model. Unlike bi-encoders (which embed query and document separately), cross-encoders process the (query, document) pair together, giving much more accurate relevance scores.

```
Hybrid Results (10 chunks)
    │
    ▼
┌────────────────────────────────┐
│  Cohere Cross-Encoder Reranker │
│                                │
│  For each chunk:               │
│    Score = model(query, chunk) │
│                                │
│  Sort by score → top 5         │
└────────────────────────────────┘
    │
    ▼
Top-5 most relevant chunks
```

**Fallback:** If the Cohere API is unavailable, a `LocalReranker` takes over. It uses a simple TF-IDF overlap score (40% original score + 60% query-term overlap) to rerank without any API call.

**Why rerank?** Retrieval is fast but approximate. Reranking is slower but far more precise. This two-stage approach (retrieve many, rerank to few) is standard in production search systems.

### Stage 4: Citation-Enforced Generation

**File:** `src/generation/rag-chain.ts`

The top-5 reranked chunks are formatted with numbered labels `[1]`, `[2]`, etc. and injected into a system prompt that **strictly requires** citations:

```
System prompt rules:
1. Every factual claim MUST have a citation like [1], [2]
2. Multiple chunks supporting a claim → cite all: [1][3]
3. If not in context → respond "I don't have enough information..."
4. Never fabricate information
```

The LLM (GPT-4o-mini, temperature=0.1) generates an answer with inline citations. The response parser then:
- Extracts all `[N]` references from the answer text
- Builds citation objects linking each reference to the actual source chunk, file name, and page number
- Returns the answer + structured citations + timing metadata

### Stage 5: Evaluation Pipeline

**Files:** `src/evaluation/evaluator.ts`, `scripts/evaluate.ts`

The evaluation system uses **LLM-as-judge** (Ragas-style) — GPT-4o-mini scores each answer on 4 metrics. This runs locally or in CI.

More details in the [Testing & Evaluation Strategy](#testing--evaluation-strategy) section below.

---

## Project Structure

```
ask-my-docs/
├── src/
│   ├── types/index.ts              # All TypeScript interfaces (15 types)
│   ├── types/pdf-parse.d.ts        # Type declaration for pdf-parse
│   ├── api/
│   │   ├── server.ts               # Express REST API (5 endpoints)
│   │   └── logger.ts               # Winston structured logger
│   ├── ingestion/
│   │   └── ingester.ts             # PDF/MD/TXT → chunks → dual index
│   ├── retrieval/
│   │   ├── bm25.ts                 # Pure TS BM25 Okapi (no dependencies)
│   │   └── hybrid-retriever.ts     # BM25 + ChromaDB vector + RRF fusion
│   ├── reranking/
│   │   └── reranker.ts             # Cohere cross-encoder + local fallback
│   ├── generation/
│   │   └── rag-chain.ts            # Citation-enforced generation + streaming
│   ├── evaluation/
│   │   └── evaluator.ts            # Ragas-style LLM judge (4 metrics)
│   └── rag-pipeline.ts             # Orchestrates retriever → reranker → chain
├── scripts/
│   ├── ingest.ts                   # CLI: npm run ingest -- ./path
│   └── evaluate.ts                 # CLI: npm run evaluate (CI exit codes)
├── frontend/
│   ├── src/
│   │   ├── App.tsx                 # React chat UI with citation viewer
│   │   └── main.tsx                # Vite entry point
│   ├── index.html                  # HTML shell
│   ├── vite.config.ts              # Vite config with API proxy
│   ├── tsconfig.json               # Frontend-specific TS config
│   ├── vite-env.d.ts               # Vite env type declarations
│   └── package.json                # Frontend dependencies (React, Vite)
├── data/
│   ├── docs/                       # Place your documents here
│   ├── uploads/                    # Temporary upload storage
│   └── eval/
│       └── golden-dataset.example.json
├── tests/
│   └── eval-docs/                  # Documents used by CI evaluation
├── .github/workflows/
│   └── eval.yml                    # GitHub Actions quality gate
├── .env.example                    # All configurable env variables
├── .gitignore
├── package.json                    # Backend dependencies & scripts
├── tsconfig.json                   # Backend TypeScript config
└── README.md
```

---

## Technology Stack

| Component           | Technology                  | Purpose                                          |
|---------------------|-----------------------------|--------------------------------------------------|
| Language            | TypeScript (strict mode)    | Type safety across the entire stack               |
| Runtime             | Node.js 20+                | ESM modules, modern JS features                   |
| LLM                 | OpenAI GPT-4o-mini          | Answer generation, evaluation judging             |
| Embeddings          | OpenAI text-embedding-3-small | 1536-dim vectors for semantic search           |
| Vector Store        | ChromaDB Cloud                | Managed vector database with ANN search           |
| BM25 Index          | Custom pure-TS              | Keyword retrieval, no external dependency          |
| Reranking           | Cohere rerank-english-v3.0  | Cross-encoder for precision reranking             |
| API Framework       | Express.js                  | REST API with Zod validation, Helmet security     |
| Frontend            | React 18 + Vite             | Chat UI with live citation viewing                |
| Logging             | Winston                     | Structured JSON logging                           |
| CI/CD               | GitHub Actions              | Automated evaluation gate on every PR             |

---

## Setup & Installation

### Prerequisites

- **Node.js 20+** — `node --version` to verify
- **API Keys:**
  - OpenAI API key (for embeddings + generation + evaluation)
  - Cohere API key (for reranking — optional, falls back to local reranker)
  - ChromaDB Cloud API key (for vector storage)

### Step 1: Clone & Install

```bash
git clone <your-repo-url>
cd ask-my-docs

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your keys:

```env
# Required
OPENAI_API_KEY=sk-proj-your-openai-key-here

# ChromaDB Cloud (required)
CHROMA_API_KEY=ck-your-chromadb-cloud-api-key
CHROMA_TENANT=your-tenant-id
CHROMA_DATABASE=ask-docs

# Optional (falls back to LocalReranker if missing)
COHERE_API_KEY=your-cohere-key-here

# Server authentication (clients must send this in x-api-key header)
API_KEY=my-secret-server-key

# Defaults (change if needed)
PORT=3000
```

### Step 3: Ingest Documents

Place your documents (`.pdf`, `.md`, `.txt`) in `data/docs/`, then run:

```bash
# Ingest an entire directory
npm run ingest -- ./data/docs

# Or ingest a single file
npm run ingest -- ./data/docs/api-reference.pdf
```

You'll see output like:

```
14:30:22 [info] Ingester initialized {"collection":"ask-my-docs"}
14:30:22 [info] Ingesting directory: ./data/docs
14:30:22 [info] Ingesting file {"filePath":"./data/docs/api-reference.pdf"}
14:30:23 [info] Created 24 chunks {"fileName":"api-reference.pdf"}
14:30:25 [info] File ingested successfully {"fileName":"api-reference.pdf","chunks":24}
14:30:25 [info] BM25 index saved {"documents":24}
14:30:25 [info] Done. Files: 1, Chunks: 24, Failures: 0
```

### Step 4: Start the API Server

```bash
npm run dev
```

Output:

```
14:31:00 [info] Ask My Docs API running on port 3000
14:31:00 [info] Health: http://localhost:3000/health
```

Test it:

```bash
# Health check
curl http://localhost:3000/health

# Ask a question
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-secret-server-key" \
  -d '{"question": "How does authentication work?"}'
```

### Step 5: Start the Frontend

In a separate terminal:

```bash
cd frontend

# Create environment config
echo "VITE_API_URL=http://localhost:3000" > .env.local
echo "VITE_API_KEY=my-secret-server-key" >> .env.local

# Start the dev server
npm run dev
```

Open `http://localhost:5173` in your browser. You'll see the chat interface where you can:
- Upload documents via the "Upload Docs" button
- Ask questions and get answers with clickable `[1]`, `[2]` citations
- Click any citation to see the source text in the side panel

---

## API Reference

### `GET /health`

Returns server status.

```json
{ "status": "ok", "timestamp": "2026-03-02T10:00:00.000Z" }
```

### `POST /query`

Ask a question. Requires `x-api-key` header.

**Request:**
```json
{
  "question": "What is the rate limit for the API?",
  "topK": 5
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "answer": "The API rate limit is 1000 requests per minute per user [1]. Enterprise accounts have a higher limit of 5000 requests per minute [2].",
    "citations": [
      {
        "id": 1,
        "source": "./data/docs/api-docs.pdf",
        "fileName": "api-docs.pdf",
        "pageNumber": 12,
        "text": "Rate limiting: Each authenticated user is limited to 1000 API requests per minute..."
      },
      {
        "id": 2,
        "source": "./data/docs/api-docs.pdf",
        "fileName": "api-docs.pdf",
        "pageNumber": 13,
        "text": "Enterprise tier customers receive an elevated rate limit of 5000 requests per minute..."
      }
    ],
    "metadata": {
      "queryTime": 1456,
      "retrievalTime": 185,
      "rerankTime": 420,
      "generationTime": 851,
      "totalTime": 1456,
      "model": "gpt-4o-mini",
      "chunksRetrieved": 5,
      "chunksAfterRerank": 5
    }
  }
}
```

### `POST /ingest`

Upload files for indexing. Multipart form data with field name `files`.

```bash
curl -X POST http://localhost:3000/ingest \
  -H "x-api-key: my-secret-server-key" \
  -F "files=@./my-document.pdf" \
  -F "files=@./another-doc.md"
```

### `POST /ingest/directory`

Index all documents in a server-side directory.

```json
{ "dirPath": "./data/docs" }
```

### `GET /stats`

Returns index size.

```json
{ "bm25DocumentCount": 142, "timestamp": "2026-03-02T10:05:00.000Z" }
```

---

## Testing & Evaluation Strategy

The evaluation pipeline is the most critical quality mechanism. It uses an **LLM-as-judge** approach inspired by [Ragas](https://docs.ragas.io/) to score each answer on four orthogonal dimensions.

### Evaluation Metrics Explained

| Metric | What it Measures | How it's Judged | Threshold |
|--------|-----------------|-----------------|-----------|
| **Faithfulness** | Are all claims in the answer grounded in the retrieved context? No hallucinations? | LLM checks each claim against context chunks. Score 1.0 = fully grounded, 0.0 = fabricated. | >= 85% |
| **Answer Relevancy** | Does the answer actually address the question asked? | LLM evaluates if the answer is on-topic and complete. | >= 80% |
| **Context Precision** | Were the retrieved chunks relevant to the question? | LLM checks each retrieved chunk for relevance. High score = retrieval is focused. | >= 75% |
| **Context Recall** | Did retrieval find ALL the chunks needed to answer correctly? | LLM compares retrieved chunks against the ground truth answer. High score = nothing was missed. | >= 70% |

**Why these four?** They cover the entire pipeline:
- Context Precision + Context Recall measure **retrieval quality**
- Faithfulness measures **generation grounding** (no hallucination)
- Answer Relevancy measures **end-to-end usefulness**

### Creating a Golden Dataset

A golden dataset is a set of Q&A pairs where you know the correct answer and which documents should be retrieved. This is the ground truth your system is evaluated against.

Copy and edit the example:

```bash
cp data/eval/golden-dataset.example.json data/eval/golden-dataset.json
```

**Format:**

```json
[
  {
    "id": "auth-flow",
    "question": "How does the OAuth2 authentication flow work?",
    "groundTruthAnswer": "The system uses OAuth2 authorization code flow. Users are redirected to the auth server, get an authorization code, exchange it for an access token via /token endpoint. Tokens expire after 1 hour and can be refreshed using a refresh token.",
    "relevantSources": ["auth-guide.md", "api-reference.pdf"]
  },
  {
    "id": "rate-limits",
    "question": "What are the API rate limits?",
    "groundTruthAnswer": "Standard accounts: 1000 requests/minute. Enterprise: 5000 requests/minute. Rate limit headers are included in every response.",
    "relevantSources": ["api-reference.pdf"]
  },
  {
    "id": "error-handling",
    "question": "How should I handle API errors?",
    "groundTruthAnswer": "All errors return JSON with 'error' field and HTTP status code. 4xx errors are client errors (retry won't help). 5xx errors are server errors (retry with exponential backoff). The 'retry-after' header indicates when to retry.",
    "relevantSources": ["api-reference.pdf", "best-practices.md"]
  }
]
```

**Tips for good golden samples:**
- Include 10-30 questions covering different topics in your docs
- Mix simple factual questions ("What is X?") with complex ones ("How do X and Y relate?")
- Include questions where the answer spans multiple documents
- Include questions the docs DON'T answer (to test the "I don't have info" response)

### Running Evaluation Locally

Make sure your documents are ingested and ChromaDB is running, then:

```bash
npm run evaluate
```

**Example output:**

```
============================================================
  RAG EVALUATION REPORT
============================================================
  Timestamp:     2026-03-02T14:30:00.000Z
  Samples:       10
  Passed:        8 / 10

  AVERAGE METRICS vs THRESHOLDS:
  --------------------------------------------------------
  Faithfulness:       91.2% (threshold: 85%) ✅
  Answer Relevancy:   88.5% (threshold: 80%) ✅
  Context Precision:  79.3% (threshold: 75%) ✅
  Context Recall:     74.1% (threshold: 70%) ✅

  OVERALL: ✅ PASSED
============================================================
```

- **Exit code 0** = all thresholds met (CI passes)
- **Exit code 1** = at least one threshold failed (CI blocks merge)

Detailed per-sample results are saved to `data/eval/results.json`.

### CI/CD Quality Gate

The GitHub Actions workflow (`.github/workflows/eval.yml`) runs on every PR:

```
PR opened → Install deps → Typecheck → Ingest test docs → Run evaluation → Pass/Fail
                                                                    │
                                                          Post results as PR comment
```

**What happens:**

1. Spins up ChromaDB as a Docker service
2. Installs dependencies, runs `tsc --noEmit` for type safety
3. Ingests documents from `tests/eval-docs/`
4. Runs the full evaluation against `tests/golden-dataset.json`
5. If ANY metric drops below threshold, the **PR is blocked from merging**
6. Posts a formatted results table as a PR comment

**Required GitHub Secrets:**
- `OPENAI_API_KEY` — for embeddings, generation, and LLM judge
- `COHERE_API_KEY` — for reranking (optional)
- `CHROMA_API_KEY` — for ChromaDB Cloud vector storage
- `CHROMA_TENANT` — your ChromaDB Cloud tenant ID
- `CHROMA_DATABASE` — your ChromaDB Cloud database name

### Example: Full Evaluation Run

Here's a complete example showing what happens when you evaluate:

**1. A sample from your golden dataset:**

```json
{
  "id": "deploy-requirements",
  "question": "What are the minimum system requirements for deployment?",
  "groundTruthAnswer": "Minimum requirements: 4 CPU cores, 8GB RAM, 50GB SSD storage, Ubuntu 22.04 LTS or Amazon Linux 2023.",
  "relevantSources": ["deployment-guide.md"]
}
```

**2. The pipeline processes it:**
- BM25 retrieves 20 chunks matching "system requirements deployment"
- Vector search retrieves 20 chunks semantically similar to the question
- RRF fuses them into 10 candidates
- Cohere reranks to the top 5
- GPT-4o-mini generates: *"The minimum system requirements for deployment include 4 CPU cores, 8GB of RAM, and 50GB of SSD storage [1]. The supported operating systems are Ubuntu 22.04 LTS and Amazon Linux 2023 [1][2]."*

**3. The evaluator judges each metric:**

| Metric | Score | Reasoning |
|--------|-------|-----------|
| Faithfulness | 1.0 | All claims (CPU, RAM, storage, OS) directly supported by context chunks |
| Answer Relevancy | 0.95 | Directly answers "what are the requirements" with specific numbers |
| Context Precision | 0.80 | 4 of 5 retrieved chunks were relevant; 1 was about unrelated config |
| Context Recall | 1.0 | Retrieved context contained ALL facts from the ground truth answer |

**4. Result:** This sample **passes** (all scores above thresholds).

---

## Configuration & Customization

All major behaviors can be changed without modifying core logic:

| Setting | Where | Default | Notes |
|---------|-------|---------|-------|
| LLM model | `src/generation/rag-chain.ts` | `gpt-4o-mini` | Swap to `gpt-4o`, Claude, Gemini, etc. |
| Embedding model | `src/ingestion/ingester.ts` + `src/retrieval/hybrid-retriever.ts` | `text-embedding-3-small` | Must match in both files |
| Vector store | `src/retrieval/hybrid-retriever.ts` + `src/ingestion/ingester.ts` | ChromaDB Cloud | Replace with Qdrant, Pinecone, Weaviate |
| Reranker | `src/rag-pipeline.ts` | `CrossEncoderReranker` | Change to `LocalReranker` for no-API mode |
| Chunk size | `DocumentIngester` constructor | 512 chars, 50 overlap | Larger = more context per chunk, fewer chunks |
| BM25 top-K | `src/rag-pipeline.ts` | 20 | More candidates = broader coverage, slower |
| Vector top-K | `src/rag-pipeline.ts` | 20 | Same tradeoff |
| Reranker top-N | `src/rag-pipeline.ts` | 5 | Final chunks given to the LLM |
| RRF constant | `src/rag-pipeline.ts` | 60 | Higher = less impact from rank position |
| Eval thresholds | `.env` | 85/80/75/70% | Adjust these as your system improves |
| Server port | `.env` | 3000 | |
| Log level | `.env` (`LOG_LEVEL`) | `info` | `debug` for verbose, `warn` for quiet |
