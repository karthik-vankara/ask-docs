import React, { useState, useRef, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Citation {
  id: number;
  source: string;
  fileName: string;
  pageNumber?: number;
  text: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  metadata?: {
    totalTime: number;
    chunksRetrieved: number;
    model: string;
  };
}

// ─── API Client ───────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";

async function queryRAG(question: string): Promise<{
  answer: string;
  citations: Citation[];
  metadata: Message["metadata"];
}> {
  const res = await fetch(`${API_URL}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ question }),
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();
  return {
    answer: json.data.answer,
    citations: json.data.citations,
    metadata: json.data.metadata,
  };
}

async function ingestFiles(files: File[]): Promise<void> {
  const formData = new FormData();
  files.forEach((f) => formData.append("files", f));

  const res = await fetch(`${API_URL}/ingest`, {
    method: "POST",
    headers: { "x-api-key": API_KEY },
    body: formData,
  });

  if (!res.ok) throw new Error(`Ingest error: ${res.status}`);
}

// ─── Citation Renderer ────────────────────────────────────────────────────────

function renderAnswerWithCitations(
  answer: string,
  citations: Citation[],
  onCitationClick: (c: Citation) => void
): React.ReactNode {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const id = parseInt(match[1]!, 10);
      const citation = citations.find((c) => c.id === id);
      if (citation) {
        return (
          <button
            key={i}
            onClick={() => onCitationClick(citation)}
            className="citation-badge"
            title={citation.fileName}
          >
            [{id}]
          </button>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const { answer, citations, metadata } = await queryRAG(question);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: answer, citations, metadata },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, an error occurred. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList) as File[];
    setUploadStatus(`Uploading ${files.length} file(s)...`);
    try {
      await ingestFiles(files);
      setUploadStatus(`${files.length} file(s) ingested successfully`);
    } catch {
      setUploadStatus("Upload failed");
    }
    setTimeout(() => setUploadStatus(""), 4000);
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="logo">📚</div>
          <div>
            <h1>Ask My Docs</h1>
            <span className="subtitle">
              Hybrid RAG · Reranking · Citations
            </span>
          </div>
        </div>
        <div className="header-right">
          <button
            className="upload-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            + Upload Docs
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.md,.txt"
            style={{ display: "none" }}
            onChange={handleFileUpload}
          />
          {uploadStatus && (
            <span className="upload-status">{uploadStatus}</span>
          )}
        </div>
      </header>

      <div className="main-layout">
        {/* Chat Area */}
        <div className="chat-area">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">🔍</div>
              <h2>Ask anything about your documents</h2>
              <p>
                Upload PDFs, Markdown, or text files, then ask questions.
                <br />
                Every answer includes citations linked to source chunks.
              </p>
              <div className="example-questions">
                {[
                  "What is the API rate limit?",
                  "How does authentication work?",
                  "What are the system requirements?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="example-btn"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`message message-${msg.role}`}>
              <div className="message-role">
                {msg.role === "user" ? "You" : "Assistant"}
              </div>
              <div className="message-content">
                {msg.role === "assistant" && msg.citations
                  ? renderAnswerWithCitations(
                      msg.content,
                      msg.citations,
                      setActiveCitation
                    )
                  : msg.content}
              </div>
              {msg.role === "assistant" && msg.metadata && (
                <div className="message-meta">
                  {msg.metadata.totalTime}ms · {msg.metadata.chunksRetrieved}{" "}
                  chunks · {msg.metadata.model}
                </div>
              )}
              {msg.role === "assistant" &&
                msg.citations &&
                msg.citations.length > 0 && (
                  <div className="citation-list">
                    {msg.citations.map((c) => (
                      <button
                        key={c.id}
                        className="citation-pill"
                        onClick={() => setActiveCitation(c)}
                      >
                        [{c.id}] {c.fileName}
                        {c.pageNumber ? ` · p.${c.pageNumber}` : ""}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          ))}

          {loading && (
            <div className="message message-assistant">
              <div className="message-role">Assistant</div>
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Citation Detail Panel */}
        {activeCitation && (
          <div className="citation-panel">
            <div className="citation-panel-header">
              <h3>Source [{activeCitation.id}]</h3>
              <button onClick={() => setActiveCitation(null)}>✕</button>
            </div>
            <div className="citation-file">
              📄 {activeCitation.fileName}
              {activeCitation.pageNumber &&
                ` — Page ${activeCitation.pageNumber}`}
            </div>
            <div className="citation-text">{activeCitation.text}</div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask a question about your documents..."
          rows={2}
          disabled={loading}
        />
        <button onClick={handleSend} disabled={loading || !input.trim()}>
          {loading ? "..." : "Ask →"}
        </button>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Georgia', serif; background: #0f0f0f; color: #e8e0d0; }
        .app-container {
          display: flex; flex-direction: column; height: 100vh; max-width: 1400px; margin: 0 auto;
        }
        .app-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 16px 24px; border-bottom: 1px solid #2a2a2a; background: #111;
        }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .logo { font-size: 28px; }
        h1 { font-size: 20px; font-weight: 600; color: #f5f0e8; letter-spacing: -0.3px; }
        .subtitle { font-size: 11px; color: #666; font-family: monospace; }
        .header-right { display: flex; align-items: center; gap: 12px; }
        .upload-btn {
          padding: 8px 16px; background: #c8a96e; color: #0f0f0f;
          border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
        }
        .upload-btn:hover { background: #d4b87a; }
        .upload-status { font-size: 12px; color: #888; }
        .main-layout { flex: 1; display: flex; overflow: hidden; }
        .chat-area {
          flex: 1; overflow-y: auto; padding: 24px;
          display: flex; flex-direction: column; gap: 20px;
        }
        .empty-state {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center; text-align: center; gap: 16px; padding: 60px 20px;
        }
        .empty-icon { font-size: 48px; }
        .empty-state h2 { font-size: 22px; color: #f5f0e8; }
        .empty-state p { color: #888; line-height: 1.6; font-size: 14px; }
        .example-questions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px; }
        .example-btn {
          padding: 8px 14px; background: #1a1a1a; border: 1px solid #333;
          border-radius: 20px; color: #aaa; cursor: pointer; font-size: 13px; font-family: Georgia, serif;
        }
        .example-btn:hover { border-color: #c8a96e; color: #c8a96e; }
        .message { display: flex; flex-direction: column; gap: 8px; max-width: 800px; }
        .message-user { align-self: flex-end; align-items: flex-end; }
        .message-assistant { align-self: flex-start; }
        .message-role { font-size: 11px; color: #555; font-family: monospace; text-transform: uppercase; }
        .message-content {
          padding: 14px 18px; border-radius: 12px; line-height: 1.7; font-size: 15px;
        }
        .message-user .message-content { background: #1e2a3a; color: #c8d8e8; }
        .message-assistant .message-content { background: #1a1a1a; border: 1px solid #2a2a2a; color: #e8e0d0; }
        .message-meta { font-size: 11px; color: #444; font-family: monospace; }
        .citation-badge {
          display: inline-block; padding: 1px 6px; background: #c8a96e22;
          border: 1px solid #c8a96e66; border-radius: 4px; color: #c8a96e;
          font-size: 12px; cursor: pointer; margin: 0 2px; font-family: monospace;
        }
        .citation-badge:hover { background: #c8a96e44; }
        .citation-list { display: flex; flex-wrap: wrap; gap: 6px; }
        .citation-pill {
          padding: 4px 10px; background: #1a1a1a; border: 1px solid #333;
          border-radius: 20px; color: #888; cursor: pointer; font-size: 12px; font-family: monospace;
        }
        .citation-pill:hover { border-color: #c8a96e; color: #c8a96e; }
        .citation-panel {
          width: 360px; border-left: 1px solid #2a2a2a;
          background: #111; display: flex; flex-direction: column; overflow-y: auto;
        }
        .citation-panel-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 16px 20px; border-bottom: 1px solid #222;
        }
        .citation-panel-header h3 { font-size: 14px; color: #c8a96e; }
        .citation-panel-header button { background: none; border: none; color: #555; cursor: pointer; font-size: 16px; }
        .citation-file { padding: 12px 20px; font-size: 12px; color: #888; font-family: monospace; }
        .citation-text {
          padding: 0 20px 20px; font-size: 13px; color: #aaa; line-height: 1.7; white-space: pre-wrap;
        }
        .input-area {
          display: flex; gap: 12px; padding: 16px 24px;
          border-top: 1px solid #2a2a2a; background: #111;
        }
        .input-area textarea {
          flex: 1; padding: 12px 16px; background: #1a1a1a;
          border: 1px solid #333; border-radius: 8px; color: #e8e0d0;
          font-family: Georgia, serif; font-size: 14px; resize: none; outline: none;
        }
        .input-area textarea:focus { border-color: #c8a96e44; }
        .input-area button {
          padding: 12px 24px; background: #c8a96e; color: #0f0f0f;
          border: none; border-radius: 8px; cursor: pointer;
          font-size: 14px; font-weight: 600; white-space: nowrap;
        }
        .input-area button:disabled { opacity: 0.4; cursor: not-allowed; }
        .input-area button:hover:not(:disabled) { background: #d4b87a; }
        .typing-indicator { display: flex; gap: 4px; align-items: center; padding: 8px 0; }
        .typing-indicator span {
          width: 6px; height: 6px; background: #555; border-radius: 50%;
          animation: bounce 1.2s infinite;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  );
}
