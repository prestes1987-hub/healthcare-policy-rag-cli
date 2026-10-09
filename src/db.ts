import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * documents ── um registro por arquivo ingerido (hash para ingestão incremental)
 * chunks    ── trechos + embedding (Float32 em BLOB) + motivo de quarentena, se houver
 * meta      ── modelo de embedding usado na indexação
 * audit_log ── trilha de auditoria de cada pergunta (sempre com dados pessoais mascarados)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  quarantine  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  question   TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  rule_id    TEXT,
  violations TEXT NOT NULL,
  sources    TEXT NOT NULL
);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // slice() copia para um buffer alinhado em 4 bytes
  return new Float32Array(blob.slice().buffer);
}

export interface StoredChunk {
  id: number;
  path: string;
  chunkIndex: number;
  content: string;
  embedding: Float32Array;
  quarantine: string | null;
}

export function loadChunks(db: DatabaseSync): StoredChunk[] {
  const rows = db.prepare(`
    SELECT c.id, d.path, c.chunk_index, c.content, c.embedding, c.quarantine
    FROM chunks c JOIN documents d ON d.id = c.document_id
    ORDER BY d.path, c.chunk_index
  `).all() as Array<{ id: number; path: string; chunk_index: number; content: string; embedding: Uint8Array; quarantine: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    chunkIndex: r.chunk_index,
    content: r.content,
    embedding: fromBlob(r.embedding),
    quarantine: r.quarantine
  }));
}

export function countChunks(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
}

export interface AuditEntry {
  question: string;
  outcome: string;
  ruleId?: string;
  violations: string[];
  sources: string[];
}

export function writeAudit(db: DatabaseSync, entry: AuditEntry): void {
  db.prepare("INSERT INTO audit_log (created_at, question, outcome, rule_id, violations, sources) VALUES (?, ?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), entry.question, entry.outcome, entry.ruleId ?? null,
      JSON.stringify(entry.violations), JSON.stringify(entry.sources));
}
