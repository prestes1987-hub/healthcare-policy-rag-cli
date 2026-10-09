import type { RetrievedChunk } from "./retrieval.ts";
import { splitSentences, tokenize } from "./text.ts";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmRequest {
  /** Contexto completo montado pela context injection (usado por LLMs reais). */
  messages: ChatMessage[];
  question: string;
  sources: RetrievedChunk[];
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<string>;
}

export class OpenAIChatProvider implements LlmProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; model: string; baseUrl: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.name = `openai:${options.model}`;
  }

  async complete(request: LlmRequest): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages: request.messages }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`LLM: HTTP ${response.status} ${await response.text()}`);
    const data = await response.json() as { choices: Array<{ message: { content: string | null } }> };
    const text = data.choices[0]?.message.content?.trim();
    if (!text) throw new Error("O LLM não retornou texto.");
    return text;
  }
}

/**
 * "LLM" offline e determinístico: responde de forma extrativa com as frases dos trechos
 * recuperados que mais se parecem com a pergunta. Ele NÃO conhece as regras — de propósito:
 * a conformidade tem de vir da arquitetura, não da boa vontade do modelo.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock-extrativo";

  async complete(request: LlmRequest): Promise<string> {
    const query = new Set(tokenize(request.question));
    const seen = new Set<string>();
    const scored: Array<{ sentence: string; path: string; overlap: number }> = [];
    for (const source of request.sources) {
      for (const sentence of splitSentences(source.content)) {
        if (seen.has(sentence)) continue;
        seen.add(sentence);
        const overlap = new Set(tokenize(sentence).filter((t) => query.has(t))).size;
        if (overlap) scored.push({ sentence, path: source.path, overlap });
      }
    }
    scored.sort((a, b) => b.overlap - a.overlap);
    const picked = scored.slice(0, 3);
    if (!picked.length) return "Os documentos recuperados não trazem detalhes suficientes sobre essa pergunta.";
    return picked.map((p) => `${p.sentence} [${p.path}]`).join("\n");
  }
}

/** Devolve sempre o mesmo texto — usado nos testes para simular um LLM que tenta violar as regras. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "llm-adversario";
  private readonly output: string;

  constructor(output: string) {
    this.output = output;
  }

  async complete(): Promise<string> {
    return this.output;
  }
}
