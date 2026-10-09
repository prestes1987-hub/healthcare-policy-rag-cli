import type { Answer } from "./layers/execution.ts";
import type { SearchOptions } from "./retrieval.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const head = (s: string) => `\x1b[36m[debug] ${s}\x1b[0m`;
const MAX_CANDIDATES = 8;

/** Imprime (em stderr) o caminho completo de uma pergunta pelas três camadas. */
export function printDebug(answer: Answer, search: SearchOptions): void {
  const { trace } = answer;
  const out: string[] = [];

  out.push(head(`entrada (após mascaramento): ${trace.maskedQuestion}`));
  out.push(head(`guarda de entrada: ${trace.inputViolations.length ? "" : "OK"}`));
  for (const v of trace.inputViolations) out.push(`   ✘ ${v.ruleId} ${v.title} — detector: "${v.match}"`);

  if (trace.retrieval) {
    out.push(head(`busca híbrida — threshold ${search.threshold.toFixed(2)} | peso vetorial ${search.vectorWeight} | top-k ${search.topK}`));
    const selected = new Set(trace.retrieval.selected.map((c) => c.id));
    for (const c of trace.retrieval.candidates.slice(0, MAX_CANDIDATES)) {
      const mark = c.quarantine ? "⛔" : selected.has(c.id) ? "✔" : "✘";
      const status = c.quarantine ? ` QUARENTENA (${c.quarantine})` : c.score < search.threshold ? " abaixo do threshold" : selected.has(c.id) ? "" : " fora do top-k";
      const preview = c.content.replace(/\s+/g, " ").slice(0, 70);
      out.push(`   ${mark} ${c.score.toFixed(3)} (vetorial ${c.vectorScore.toFixed(3)} | lexical ${c.lexicalScore.toFixed(3)}) ${c.path}#${c.chunkIndex}${status}`);
      out.push(dim(`       "${preview}…"`));
    }
    const hidden = trace.retrieval.candidates.length - MAX_CANDIDATES;
    if (hidden > 0) out.push(dim(`   … e mais ${hidden} trechos`));
  }

  if (trace.messages) {
    out.push(head("contexto injetado:"));
    for (const m of trace.messages) out.push(dim(`── ${m.role} ──\n${m.content}`));
  }
  if (trace.rawOutput !== undefined) out.push(head("saída bruta do LLM:"), dim(trace.rawOutput));
  if (trace.rawOutput !== undefined) {
    out.push(head(`guarda de saída: ${trace.outputViolations.length ? "" : "OK"}`));
    for (const v of trace.outputViolations) out.push(`   ✘ ${v.ruleId} ${v.title} — detector: "${v.match}"`);
  }
  out.push(head(`enforcement: ${trace.enforcement.join(" | ")}`));
  out.push(head(`desfecho: ${answer.outcome}${answer.ruleId ? ` (${answer.ruleId})` : ""}`));
  console.error(out.join("\n"));
}
