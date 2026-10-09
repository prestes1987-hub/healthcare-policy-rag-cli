/** Mecanismo de detecção usado pela camada de execução: aplica os detectores das REGRAS a um texto. */
import { normalizeForGuard } from "../text.ts";
import { RULES, type Severity, type Stage } from "./rules.ts";

export interface Violation {
  ruleId: string;
  title: string;
  severity: Severity;
  stage: Stage;
  /** Trecho (normalizado) que disparou o detector. */
  match: string;
}

/** Violações em ordem de prioridade das regras (no máximo uma por regra). */
export function inspect(text: string, stage: Stage): Violation[] {
  const normalized = normalizeForGuard(text);
  const violations: Violation[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns[stage] ?? []) {
      const match = normalized.match(pattern);
      if (match) {
        violations.push({ ruleId: rule.id, title: rule.title, severity: rule.severity, stage, match: match[0].trim() });
        break;
      }
    }
  }
  return violations;
}
