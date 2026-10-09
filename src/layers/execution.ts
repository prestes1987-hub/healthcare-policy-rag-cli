/**
 * CAMADA 3 — EXECUÇÃO
 *
 * Pipeline determinístico que faz as regras valerem, independentemente do modelo:
 *
 *   pergunta ─► [1] mascarar PII ─► [2] guarda de entrada ─► [3] busca híbrida + threshold
 *            ─► [4] context injection ─► [5] LLM ─► [6] guarda de saída
 *            ─► [7] aviso legal + fontes ─► [8] auditoria ─► resposta
 *
 * Qualquer bloqueio devolve uma resposta segura da camada de instruções — nunca o texto bloqueado.
 */
import type { DatabaseSync } from "node:sqlite";
import { writeAudit } from "../db.ts";
import type { Embedder } from "../embeddings.ts";
import type { ChatMessage, LlmProvider } from "../llm.ts";
import { hybridSearch, type RetrievalResult, type SearchOptions } from "../retrieval.ts";
import { maskIdentifiers, maskPII, stripMasks } from "../text.ts";
import { buildMessages } from "./context-injection.ts";
import { inspect, type Violation } from "./guards.ts";
import { DISCLAIMER, SAFE_RESPONSES } from "./instructions.ts";

export type Outcome = "answered" | "blocked_input" | "blocked_output" | "no_context";

export interface Engine {
  db: DatabaseSync;
  embedder: Embedder;
  llm: LlmProvider;
  search: SearchOptions;
}

export interface Trace {
  maskedQuestion: string;
  inputViolations: Violation[];
  retrieval?: RetrievalResult;
  messages?: ChatMessage[];
  rawOutput?: string;
  outputViolations: Violation[];
  enforcement: string[];
}

export interface Answer {
  outcome: Outcome;
  /** Regra que determinou o desfecho (quando houve bloqueio ou falta de contexto). */
  ruleId?: string;
  text: string;
  sources: string[];
  trace: Trace;
}

export async function answerQuestion(engine: Engine, question: string): Promise<Answer> {
  // [1] LGPD: nada abaixo (busca, LLM, logs) vê dados pessoais crus.
  const trace: Trace = { maskedQuestion: maskPII(question.trim()), inputViolations: [], outputViolations: [], enforcement: [] };
  if (trace.maskedQuestion !== question.trim()) trace.enforcement.push("R7: dados pessoais mascarados na entrada.");

  // [2] Guarda de entrada: bloqueia antes de gastar busca e LLM.
  trace.inputViolations = inspect(trace.maskedQuestion, "input");
  const blocking = trace.inputViolations[0];
  if (blocking) return finish(engine, trace, "blocked_input", SAFE_RESPONSES[blocking.ruleId] ?? SAFE_RESPONSES.R8, [], blocking.ruleId);

  // [3] Grounding: sem trecho acima do threshold não há resposta.
  trace.retrieval = await hybridSearch(engine.db, engine.embedder, stripMasks(trace.maskedQuestion), engine.search);
  const context = trace.retrieval.selected;
  if (!context.length) return finish(engine, trace, "no_context", SAFE_RESPONSES.NO_CONTEXT, [], "R5");

  // [4] + [5]
  trace.messages = buildMessages(trace.maskedQuestion, context);
  trace.rawOutput = await engine.llm.complete({ messages: trace.messages, question: trace.maskedQuestion, sources: context });

  // [6] Guarda de saída: o modelo pode errar ou ser manipulado; a saída é verificada sempre.
  trace.outputViolations = inspect(trace.rawOutput, "output");
  if (trace.outputViolations.length) {
    return finish(engine, trace, "blocked_output", SAFE_RESPONSES.OUTPUT_BLOCKED, [], trace.outputViolations[0].ruleId);
  }
  const body = maskIdentifiers(trace.rawOutput);
  if (body !== trace.rawOutput) trace.enforcement.push("R7: identificadores pessoais removidos da resposta.");

  return finish(engine, trace, "answered", body, [...new Set(context.map((c) => c.path))]);
}

// [7] + [8]
function finish(engine: Engine, trace: Trace, outcome: Outcome, body: string, sources: string[], ruleId?: string): Answer {
  let text = body.trim();
  if (sources.length) text += `\n\nFontes: ${sources.join("; ")}`;
  text += `\n\n${DISCLAIMER}`;
  trace.enforcement.push("R4: aviso legal anexado.");

  writeAudit(engine.db, {
    question: trace.maskedQuestion,
    outcome,
    ruleId,
    violations: [...trace.inputViolations, ...trace.outputViolations].map((v) => `${v.stage}:${v.ruleId}`),
    sources
  });
  return { outcome, ruleId, text, sources, trace };
}
