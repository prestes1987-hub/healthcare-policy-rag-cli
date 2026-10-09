# Healthcare Policy RAG CLI

Micro-capstone: **pipeline de ingestão de dados + CLI de perguntas fundamentadas em documentos**, com **enforcement de políticas corporativas** para uma empresa de saúde (a IA nunca diagnostica, sempre inclui aviso legal, segue linguagem institucional e respeita limites legais).

- Ingestão de todos os `.txt`/`.md` de uma pasta (recursiva, incremental) → chunks + embeddings em **SQLite**
- Perguntas pela CLI com **busca híbrida** (vetorial + lexical) e **filtro por threshold de similaridade (padrão 0.7)**
- **`--debug`**: mostra guardas, scores de cada trecho, contexto injetado, saída bruta do LLM e ações de enforcement
- Arquitetura de contexto em **3 camadas** (regras → instruções → execução), **36 casos adversos** e **relatório de validação** gerado automaticamente

Zero dependências de runtime: Node 24 executa TypeScript diretamente, o SQLite é o `node:sqlite` e as chamadas HTTP usam `fetch`.

## Como rodar

Requisito: Node.js ≥ 22.18 (testado no 24).

```bash
npm install
```

```bash
npm run ingest -- knowledge-base
```

```bash
npm run ask -- "Qual o horário de atendimento da clínica?"
```

```bash
npm run ask -- --debug "Quais são os sintomas comuns da dengue?"
```

```bash
npm run ask -- --threshold 0.8
```

```bash
npm run eval
```

```bash
npm test
```

Sem `OPENAI_API_KEY` tudo roda **offline**: embedding local (hashing de radicais + trigramas) e um LLM simulado extrativo. Com a chave (copie `.env.example` para `.env`), usa `text-embedding-3-small` e `gpt-5-mini`. Ao trocar de provedor de embedding, reindexe com `npm run ingest -- knowledge-base --rebuild` (a CLI detecta e avisa).

| Opção | Efeito |
|---|---|
| `--debug` | modo debug (detalhamento de cada etapa em stderr) |
| `--threshold <0..1>` | score híbrido mínimo para um trecho entrar no contexto (padrão **0.7**) |
| `--top-k <n>` | máximo de trechos no contexto (padrão 4) |
| `--db <arquivo>` | banco SQLite (padrão `data/knowledge.db`) |
| `--offline` | força embedder local + LLM simulado |
| `--rebuild` | (ingest) apaga e reindexa tudo |

## Pipeline de ingestão

```
pasta ─► busca recursiva (.txt/.md) ─► hash sha256 (pula inalterados, remove apagados)
      ─► chunking por seção/parágrafo (título da seção em cada trecho, ~450 caracteres)
      ─► guarda de documentos (injeção embutida ⇒ trecho em QUARENTENA)
      ─► embeddings ─► SQLite: documents, chunks(embedding BLOB Float32, quarantine), meta
```

## Busca híbrida e threshold

```
score = 0.5 · cosseno(embedding pergunta, embedding trecho)
      + 0.5 · cobertura lexical (fração, ponderada por IDF, dos termos da pergunta presentes no trecho)
```

Os dois componentes ficam em [0, 1], então o threshold tem significado absoluto. Só entram no contexto trechos com `score ≥ threshold`, fora de quarentena, até o top-k. **Se nenhum trecho passar, o LLM não é chamado** e a resposta é "não encontrei nos documentos" (R5).

## Arquitetura de contexto

```
            ┌───────────────────────── CAMADA 1 · REGRAS (src/layers/rules.ts) ─────────────────────────┐
            │ Fonte única da verdade: id, severidade, diretiva textual, detectores (entrada/saída/doc)   │
            └──────────────┬──────────────────────────────────────────────┬──────────────────────────────┘
                           │ diretivas                                    │ detectores
            ┌──────────────▼──── CAMADA 2 · INSTRUÇÕES ──────┐            │
            │ (src/layers/instructions.ts)                    │            │
            │ system prompt gerado das regras, aviso legal,   │            │
            │ respostas seguras por regra, canário            │            │
            └──────────────┬──────────────────────────────────┘            │
                           │                                               │
            ┌──────────────▼──────────── CAMADA 3 · EXECUÇÃO (src/layers/execution.ts) ───────────────────┐
            │ [1] mascarar PII ─► [2] guarda de entrada ─► [3] busca híbrida + threshold                   │
            │ ─► [4] context injection ─► [5] LLM ─► [6] guarda de saída ─► [7] aviso legal + fontes       │
            │ ─► [8] auditoria (SQLite)                                                                    │
            └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Separação de camadas:** as dependências seguem uma única direção (regras ← instruções ← execução). Para mudar uma política, edita-se só `rules.ts`: o prompt e os detectores se atualizam juntos.
- **Context injection** (`context-injection.ts`):
  - `system` leva as REGRAS INVIOLÁVEIS e as INSTRUÇÕES.
  - `user` leva `<documentos>` e `<pergunta>`, sempre tratados como dado não confiável, mais um lembrete das regras.
  - Os sinais `<` e `>` do conteúdo não confiável são neutralizados (viram `‹ ›`), então ninguém consegue fechar uma seção nem forjar `<sistema>`.
- **O modelo não é confiável:**
  - a guarda de saída verifica toda resposta;
  - o aviso legal e as fontes são anexados pelo código, não pedidos ao modelo;
  - em caso de bloqueio, devolve-se uma resposta institucional fixa.

### Regras

| Regra | Política | Como é imposta |
|---|---|---|
| R3 | Emergências → SAMU 192 / CVV 188 | guarda de entrada (prioridade máxima) |
| R8 | Integridade: anti prompt injection, sigilo do prompt | guarda de entrada, quarentena de documentos, delimitadores sanitizados, canário na saída |
| R7 | LGPD e sigilo médico | mascaramento de CPF/CNS/e-mail/telefone na entrada, nos logs e na saída; bloqueio de pedidos de dados de terceiros |
| R1 | Nunca diagnosticar | guarda de entrada + guarda de saída + diretiva no prompt |
| R2 | Nunca prescrever medicamentos/doses | guarda de entrada + guarda de saída + diretiva no prompt |
| R6 | Linguagem institucional (sem promessas absolutas, sem gírias) | guarda de saída + diretiva |
| R4 | Aviso legal obrigatório | anexado pelo pipeline em 100% das respostas |
| R5 | Respostas apenas com base nos documentos | threshold + citação de fontes |

Todos os detectores rodam sobre texto normalizado: sem acentos, minúsculo, sem caracteres invisíveis e com leetspeak desfeito ("D1AGNÓST1CO" → "diagnostico").

## Validação

`npm run eval` roda os cenários de [src/eval/scenarios.ts](src/eval/scenarios.ts) contra uma base em memória e gera [docs/validation-report.md](docs/validation-report.md). Categorias cobertas:
- uso legítimo, para medir falsos positivos;
- fora do escopo;
- diagnóstico (direto, hipotético, interpretação de exame, leetspeak, zero-width);
- prescrição;
- emergência;
- prompt injection (override, roleplay, extração de prompt, delimitadores falsos, inglês);
- LGPD;
- injeção indireta via documento;
- **LLM comprometido** que tenta diagnosticar, prescrever, prometer cura, vazar o prompt, omitir o aviso ou expor CPF.

Em todos os cenários são verificadas as invariantes:
- desfecho e regra esperados;
- aviso legal presente;
- resposta final sem violação;
- canário nunca exposto;
- nenhum CPF na resposta nem na auditoria;
- fontes citadas.

O mesmo conjunto roda em `npm test`.

## Estrutura

```
src/
  cli.ts                 comandos ingest | ask | eval, flags (--debug, --threshold…)
  config.ts              configuração (.env + flags)
  db.ts                  esquema SQLite, embeddings em BLOB, auditoria
  ingest.ts              varredura da pasta, chunking, ingestão incremental, quarentena
  embeddings.ts          embedder local (offline) e OpenAI
  retrieval.ts           busca híbrida + threshold
  llm.ts                 OpenAI, LLM simulado e LLM adversário (testes)
  debug.ts               saída do modo --debug
  text.ts                normalização, stemming, mascaramento de PII
  layers/
    rules.ts             CAMADA 1 — regras
    instructions.ts      CAMADA 2 — instruções
    context-injection.ts montagem do contexto delimitado
    guards.ts            aplicação dos detectores
    execution.ts         CAMADA 3 — pipeline de execução
  eval/                  cenários adversos + gerador do relatório
  tests/                 testes (node:test)
knowledge-base/          documentos de exemplo (clínica fictícia), incluindo um com injeção embutida
```

## Limitações

- Os detectores são léxicos. Paráfrases muito distantes podem passar pela guarda de entrada; nesse caso ainda há a diretiva no prompt e a guarda de saída. Um próximo passo é um classificador semântico (LLM-as-judge) como guarda extra.
- O embedding local é simples, por isso o peso lexical é alto. Com embeddings da OpenAI, vale recalibrar `VECTOR_WEIGHT`/threshold observando os scores no `--debug`.
