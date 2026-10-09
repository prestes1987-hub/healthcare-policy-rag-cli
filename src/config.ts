import { resolve } from "node:path";

export interface Config {
  dbFile: string;
  /** Score híbrido mínimo (0..1) para um trecho entrar no contexto. */
  threshold: number;
  topK: number;
  /** Peso do score vetorial no score híbrido; o restante é do score lexical. */
  vectorWeight: number;
  chunkSize: number;
  debug: boolean;
  /** Força embedder local + LLM simulado mesmo com chave configurada. */
  offline: boolean;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
}

try {
  process.loadEnvFile();
} catch {
  // .env é opcional
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return Number(value);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const config: Config = {
    dbFile: resolve(env.DB_FILE ?? "data/knowledge.db"),
    threshold: num(env.SIMILARITY_THRESHOLD, 0.7),
    topK: num(env.TOP_K, 4),
    vectorWeight: num(env.VECTOR_WEIGHT, 0.5),
    chunkSize: num(env.CHUNK_SIZE, 450),
    debug: env.DEBUG === "true",
    offline: env.OFFLINE === "true",
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    chatModel: env.OPENAI_MODEL ?? "gpt-5-mini",
    embeddingModel: env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small"
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value;
  }
  if (!(config.threshold >= 0 && config.threshold <= 1)) throw new Error("O threshold deve ser um número entre 0 e 1.");
  if (!(config.vectorWeight >= 0 && config.vectorWeight <= 1)) throw new Error("VECTOR_WEIGHT deve estar entre 0 e 1.");
  if (!(Number.isInteger(config.topK) && config.topK > 0)) throw new Error("O top-k deve ser um inteiro positivo.");
  return config;
}
