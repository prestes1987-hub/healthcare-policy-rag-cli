import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.ts";
import { countChunks, getMeta, openDb } from "./db.ts";
import { printDebug } from "./debug.ts";
import { runEval } from "./eval/run-eval.ts";
import { createEmbedder, createLlm } from "./factory.ts";
import { ingestFolder } from "./ingest.ts";
import { answerQuestion, type Engine } from "./layers/execution.ts";

const HELP = `Uso:
  npm run ingest -- [pasta] [--rebuild]      ingere todos os .txt/.md da pasta (padrão: knowledge-base)
  npm run ask -- "pergunta" [opções]         responde uma pergunta
  npm run ask -- [opções]                    modo interativo
  npm run eval -- [opções]                   roda os casos adversos e gera docs/validation-report.md

Opções:
  --debug             mostra guardas, scores da busca híbrida, contexto injetado e enforcement
  --threshold <0..1>  score híbrido mínimo para um trecho entrar no contexto (padrão 0.7)
  --top-k <n>         máximo de trechos no contexto (padrão 4)
  --db <arquivo>      banco SQLite (padrão data/knowledge.db)
  --offline           força embedder local + LLM simulado
  --rebuild           (ingest) apaga e reindexa tudo`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      debug: { type: "boolean" },
      threshold: { type: "string" },
      "top-k": { type: "string" },
      db: { type: "string" },
      offline: { type: "boolean" },
      rebuild: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) return console.log(HELP);

  const config = loadConfig({
    debug: values.debug,
    offline: values.offline,
    threshold: values.threshold === undefined ? undefined : Number(values.threshold),
    topK: values["top-k"] === undefined ? undefined : Number(values["top-k"]),
    dbFile: values.db === undefined ? undefined : resolve(values.db)
  });

  const [command = "ask", ...args] = positionals;
  switch (command) {
    case "ingest": return ingest(config, args[0] ?? "knowledge-base", values.rebuild ?? false);
    case "ask": return ask(config, args.join(" ").trim());
    case "eval": return runEval(config);
    default: throw new Error(`Comando desconhecido: "${command}".\n\n${HELP}`);
  }
}

async function ingest(config: Config, folder: string, rebuild: boolean): Promise<void> {
  const db = openDb(config.dbFile);
  const embedder = createEmbedder(config);
  console.log(`Ingerindo ${resolve(folder)} com ${embedder.name} → ${config.dbFile}`);
  const stats = await ingestFolder(db, embedder, folder, {
    chunkSize: config.chunkSize,
    rebuild,
    onFile: (path, status) => console.log(`  ${path}: ${status}`)
  });
  console.log(`\n${stats.scanned} arquivos | ${stats.added} novos | ${stats.updated} atualizados | `
    + `${stats.unchanged} sem alterações | ${stats.removed} removidos | ${stats.chunks} trechos gravados`);
  for (const q of stats.quarantined) console.log(`  ⛔ quarentena (injeção em documento): ${q.path} — ${q.reason}`);
  db.close();
}

async function ask(config: Config, question: string): Promise<void> {
  const db = openDb(config.dbFile);
  const embedder = createEmbedder(config);
  const indexedWith = getMeta(db, "embedding_model");
  if (!indexedWith || !countChunks(db)) throw new Error("Base vazia. Rode primeiro: npm run ingest -- <pasta>");
  if (indexedWith !== embedder.name) {
    throw new Error(`A base foi indexada com "${indexedWith}", mas o embedder atual é "${embedder.name}". Rode: npm run ingest -- <pasta> --rebuild`);
  }
  const engine: Engine = {
    db,
    embedder,
    llm: createLlm(config),
    search: { threshold: config.threshold, topK: config.topK, vectorWeight: config.vectorWeight }
  };
  if (config.debug) {
    console.error(`\x1b[36m[debug] modo debug ativo | llm=${engine.llm.name} | embedder=${embedder.name} | db=${config.dbFile}\x1b[0m`);
  }

  const run = async (q: string) => {
    const answer = await answerQuestion(engine, q);
    if (config.debug) printDebug(answer, engine.search);
    console.log(`\n${answer.text}\n`);
  };

  if (question) return run(question);

  console.log(`Assistente da Clínica Vida Plena (${engine.llm.name}). Digite sua pergunta ou "sair".`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const line of rl) {
    const q = line.trim();
    if (/^(sair|exit|quit)$/i.test(q)) break;
    if (q) {
      try {
        await run(q);
      } catch (error) {
        console.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    rl.prompt();
  }
  rl.close();
  db.close();
}

main().catch((error) => {
  console.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
