import type { Config } from "./config.ts";
import { LocalHashEmbedder, OpenAIEmbedder, type Embedder } from "./embeddings.ts";
import { MockProvider, OpenAIChatProvider, type LlmProvider } from "./llm.ts";

const online = (config: Config) => !config.offline && Boolean(config.openaiApiKey);

export function createEmbedder(config: Config): Embedder {
  return online(config)
    ? new OpenAIEmbedder({ apiKey: config.openaiApiKey!, model: config.embeddingModel, baseUrl: config.openaiBaseUrl })
    : new LocalHashEmbedder();
}

export function createLlm(config: Config): LlmProvider {
  return online(config)
    ? new OpenAIChatProvider({ apiKey: config.openaiApiKey!, model: config.chatModel, baseUrl: config.openaiBaseUrl })
    : new MockProvider();
}
