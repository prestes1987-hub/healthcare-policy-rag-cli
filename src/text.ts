/** Utilidades de texto compartilhadas pela ingestão, pela busca e pelas guardas de política. */

const STOPWORDS = new Set(`
a o e as os um uma uns umas de da do das dos em no na nos nas ao aos para pra por pelo pela pelos pelas
com sem sobre entre ate apos que qual quais quanto como quando onde quem porque se ou mas mais menos muito
ja nao sim isso isto esse essa este esta aquele aquela eu voce voces ele ela eles elas me te lhe
meu minha meus minhas seu sua seus suas ser sao foi sera estar estao ter tem tenho ha
faco fazer faz preciso precisa posso pode podem devo deve gostaria quero queria saber existe existem
vc vcs favor ola oi bom boa dia tarde noite
`.trim().split(/\s+/));

/** Minúsculas, sem acentos e sem caracteres invisíveis (zero-width, soft hyphen). */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[​-‍⁠﻿­]/g, "")
    .toLowerCase();
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s" };

/**
 * Normalização agressiva usada pelas guardas: além de `normalize`, desfaz leetspeak
 * no meio de palavras ("d1agn0stico" → "diagnostico") e colapsa espaços.
 * Números isolados ("750 mg", "750mg") são preservados.
 */
export function normalizeForGuard(text: string): string {
  return normalize(text)
    .replace(/(?<=[a-z])[0134578@$](?=[a-z])/g, (c) => LEET[c] ?? c)
    .replace(/\s+/g, " ");
}

const SUFFIXES = ["amentos", "imentos", "amento", "imento", "acoes", "icoes", "mente", "acao", "icao",
  "ados", "idos", "ado", "ido", "am", "em", "ar", "er", "ir", "es", "as", "os", "a", "e", "o", "s"];

/** Stemmer leve para português: aproxima "cancelar"/"cancelamento", "exame"/"exames" etc. */
export function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Termos de busca: normalizados, sem stopwords e reduzidos ao radical. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

/** Frases completas (títulos e linhas sem pontuação final ficam de fora). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*([-*]|\d+\.)\s*/, "").trim())
    .filter((s) => s.length > 20 && !s.startsWith("#") && /[.!?]$/.test(s));
}

/** Remove os marcadores de mascaramento ([CPF], [EMAIL]…), que não são conteúdo pesquisável. */
export function stripMasks(text: string): string {
  return text.replace(/\[(CPF|CNS|EMAIL|TELEFONE)\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Identificadores sensíveis (LGPD): CPF e Cartão Nacional de Saúde. */
export function maskIdentifiers(text: string): string {
  return text
    .replace(/\b\d{3}\s?\d{4}\s?\d{4}\s?\d{4}\b/g, "[CNS]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]");
}

/** Mascara identificadores e contatos pessoais (usado na entrada do usuário e nos logs). */
export function maskPII(text: string): string {
  return maskIdentifiers(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[EMAIL]")
    .replace(/(\(?\b\d{2}\)?\s?)?\b9?\d{4}-?\d{4}\b/g, "[TELEFONE]");
}
