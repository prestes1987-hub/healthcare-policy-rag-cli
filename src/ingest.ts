import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getMeta, setMeta, toBlob } from "./db.ts";
import type { Embedder } from "./embeddings.ts";
import { inspect } from "./layers/guards.ts";

const EXTENSIONS = new Set([".txt", ".md", ".markdown"]);

/** Todos os .txt/.md da pasta, recursivamente, em ordem estável. */
export function findDocuments(root: string): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Pasta não encontrada: ${root}`);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Chunking por estrutura: cada título markdown abre um novo trecho, parágrafos são
 * agrupados até `maxChars` e todo trecho carrega o título da sua seção (ajuda a busca).
 */
export function chunkText(text: string, maxChars = 700): string[] {
  const chunks: string[] = [];
  let heading = "";
  let buffer = "";
  const flush = () => {
    const body = buffer.trim();
    if (body) chunks.push(heading && !body.startsWith(heading) ? `${heading}\n${body}` : body);
    buffer = "";
  };
  for (const raw of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    let block = raw.trim();
    if (!block) continue;
    if (/^#{1,6}\s/.test(block)) {
      flush();
      const [title, ...rest] = block.split("\n");
      heading = title.trim();
      block = rest.join("\n").trim();
      if (!block) continue;
    }
    for (const piece of splitLong(block, maxChars)) {
      if (buffer && buffer.length + piece.length + 2 > maxChars) flush();
      buffer += (buffer ? "\n\n" : "") + piece;
    }
  }
  flush();
  return chunks;
}

function splitLong(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of block.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + sentence.length + 1 > maxChars) {
      pieces.push(current);
      current = "";
    }
    current += (current ? " " : "") + sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

export interface IngestStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunks: number;
  quarantined: Array<{ path: string; reason: string }>;
}

export interface IngestOptions {
  chunkSize: number;
  rebuild?: boolean;
  onFile?: (path: string, status: string) => void;
}

export async function ingestFolder(db: DatabaseSync, embedder: Embedder, folder: string, options: IngestOptions): Promise<IngestStats> {
  const root = resolve(folder);
  const files = findDocuments(root);
  const stats: IngestStats = { scanned: files.length, added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, quarantined: [] };

  // Embeddings de modelos diferentes não são comparáveis: troca de modelo = reindexação total.
  const indexedWith = getMeta(db, "embedding_model");
  if (options.rebuild || (indexedWith && indexedWith !== embedder.name)) db.exec("DELETE FROM documents");
  setMeta(db, "embedding_model", embedder.name);

  const existing = new Map((db.prepare("SELECT id, path, hash FROM documents").all() as Array<{ id: number; path: string; hash: string }>)
    .map((row) => [row.path, row]));
  const seen = new Set<string>();

  for (const file of files) {
    const path = relative(process.cwd(), file).replaceAll("\\", "/");
    seen.add(path);
    const content = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    const previous = existing.get(path);
    if (previous?.hash === hash) {
      stats.unchanged++;
      options.onFile?.(path, "sem alterações");
      continue;
    }

    const chunks = chunkText(content, options.chunkSize);
    const vectors = chunks.length ? await embedder.embed(chunks) : [];
    db.exec("BEGIN");
    try {
      if (previous) db.prepare("DELETE FROM documents WHERE id = ?").run(previous.id);
      const { lastInsertRowid } = db.prepare("INSERT INTO documents (path, hash, ingested_at) VALUES (?, ?, ?)")
        .run(path, hash, new Date().toISOString());
      const insert = db.prepare("INSERT INTO chunks (document_id, chunk_index, content, embedding, quarantine) VALUES (?, ?, ?, ?, ?)");
      chunks.forEach((chunk, i) => {
        // Defesa contra injeção indireta: trecho com instruções embutidas nunca vai para o contexto.
        const violation = inspect(chunk, "document")[0];
        const reason = violation ? `${violation.ruleId}: "${violation.match}"` : null;
        if (reason) stats.quarantined.push({ path, reason });
        insert.run(lastInsertRowid, i, chunk, toBlob(vectors[i]), reason);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    stats.chunks += chunks.length;
    if (previous) stats.updated++;
    else stats.added++;
    options.onFile?.(path, `${previous ? "atualizado" : "novo"} (${chunks.length} trechos)`);
  }

  // Remove da base os arquivos que sumiram desta pasta.
  const prefix = relative(process.cwd(), root).replaceAll("\\", "/");
  for (const [path, row] of existing) {
    if (!seen.has(path) && (prefix === "" || path.startsWith(`${prefix}/`))) {
      db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
      stats.removed++;
      options.onFile?.(path, "removido");
    }
  }
  return stats;
}
