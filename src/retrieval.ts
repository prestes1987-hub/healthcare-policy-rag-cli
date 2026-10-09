import type { DatabaseSync } from "node:sqlite";
import { loadChunks } from "./db.ts";
import { cosine, type Embedder } from "./embeddings.ts";
import { tokenize } from "./text.ts";

export interface SearchOptions {
  threshold: number;
  topK: number;
  vectorWeight: number;
}

export interface RetrievedChunk {
  id: number;
  path: string;
  chunkIndex: number;
  content: string;
  vectorScore: number;
  lexicalScore: number;
  /** Score híbrido em [0, 1], comparado com o threshold. */
  score: number;
  quarantine: string | null;
}

export interface RetrievalResult {
  /** Todos os trechos, do mais para o menos relevante (para o modo debug). */
  candidates: RetrievedChunk[];
  /** Trechos que passaram no threshold, fora de quarentena, limitados a top-k. */
  selected: RetrievedChunk[];
}

/**
 * Busca híbrida:
 *   score = w · cosseno(embedding da pergunta, embedding do trecho)
 *         + (1 − w) · cobertura lexical (fração, ponderada por IDF, dos termos da pergunta presentes no trecho)
 * Os dois componentes estão em [0, 1], então o threshold tem significado absoluto.
 */
export async function hybridSearch(db: DatabaseSync, embedder: Embedder, query: string, options: SearchOptions): Promise<RetrievalResult> {
  const chunks = loadChunks(db);
  if (!chunks.length) return { candidates: [], selected: [] };

  const [queryVector] = await embedder.embed([query]);
  const chunkTerms = chunks.map((c) => new Set(tokenize(c.content)));
  // Só entram no componente lexical os termos que existem em algum documento (palavras como
  // "CPF" ou "Natal" não têm com o que casar); a pergunta fora do domínio continua penalizada,
  // pois não casa nenhum termo e tem baixa similaridade vetorial.
  const queryTerms = [...new Set(tokenize(query))].filter((term) => chunkTerms.some((terms) => terms.has(term)));
  const idf = new Map(queryTerms.map((term) => {
    const df = chunkTerms.filter((terms) => terms.has(term)).length;
    return [term, Math.log(1 + chunks.length / df)];
  }));
  const totalIdf = [...idf.values()].reduce((sum, v) => sum + v, 0);

  const candidates = chunks.map((chunk, i): RetrievedChunk => {
    const vectorScore = Math.max(0, cosine(queryVector, chunk.embedding));
    const lexicalScore = totalIdf
      ? queryTerms.reduce((sum, term) => sum + (chunkTerms[i].has(term) ? idf.get(term)! : 0), 0) / totalIdf
      : 0;
    return {
      id: chunk.id,
      path: chunk.path,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      vectorScore,
      lexicalScore,
      score: options.vectorWeight * vectorScore + (1 - options.vectorWeight) * lexicalScore,
      quarantine: chunk.quarantine
    };
  }).sort((a, b) => b.score - a.score);

  const selected = candidates.filter((c) => !c.quarantine && c.score >= options.threshold).slice(0, options.topK);
  return { candidates, selected };
}
