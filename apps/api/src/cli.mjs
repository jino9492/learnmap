import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { createConfiguredClient, analysisOptionsFromEnv, extractConcepts, organizeConcepts, analyzeRelations, generateQuestion, publicQuestion, evaluateAnswer, recommendPath, validateMaterial, localizeResult, AiError } from "./ai/index.ts";
import { loadMaterial } from "./features/materials/index.mjs";
import { measureAnalysisStage } from "./features/material-analysis/timing.mjs";
import { validateGraph } from "./features/knowledge-graph/index.ts";
import { validateQuestion } from "./ai/question-generation/index.ts";
import { conceptCollectionSchema, relationCollectionSchema, evaluationSchema, recommendationSchema } from "./ai/core/schemas.ts";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new AiError("INPUT", "Could not read the JSON input file."); }
}

async function main() {
  const args = process.argv.slice(2);
  const isDemo = args.length === 1 && args[0] === "--demo";
  const analysisStartedAt = performance.now();
  const reportTiming = (event) => stderr.write(`${JSON.stringify(event)}\n`);
  let extractOnly = false;
  let mode = "detailed";
  if (!isDemo) {
    if (!args[0] || args[0].startsWith("--")) throw new AiError("INPUT", "Usage: npm run ai -- <document> [--concept-mode detailed|conceptual] [--extract-only]");
    for (let index = 1; index < args.length; index++) {
      if (args[index] === "--extract-only") extractOnly = true;
      else if (args[index] === "--concept-mode") mode = args[++index];
      else throw new AiError("INPUT", "Unknown CLI option.");
    }
    if (!["detailed", "conceptual"].includes(mode)) throw new AiError("INPUT", "Concept mode must be detailed or conceptual.");
  }
  const material = await measureAnalysisStage("text", async () => isDemo
    ? validateMaterial(await readJson(new URL("../../../examples/material.json", import.meta.url)))
    : await loadMaterial(args[0]), reportTiming);
  if (extractOnly) {
    stdout.write(`${JSON.stringify(material, null, 2)}\n`);
    return;
  }
  let client;
  if (isDemo) {
    stderr.write("OFFLINE FIXTURE DEMO: outputs are predefined; no AI inference takes place.\n");
    const fixture = await readJson(new URL("../../../examples/fixture.json", import.meta.url));
    client = { async generate(request) {
      const value = structuredClone(fixture[request.name]);
      if (request.name === "concept_extraction") {
        for (const concept of value.concepts) {
          const source = request.data.sources.find((source) => source.location === concept.sourceLocation);
          const excerpt = source?.excerpts.find((excerpt) => excerpt.text.includes(concept.evidence));
          if (!excerpt) throw new AiError("FORMAT", "Demo concept does not match its source excerpt.");
          concept.evidence = excerpt.id;
        }
      }
      return request.schema.parse(value);
    } };
  } else {
    client = createConfiguredClient(process.env, {
      onEvent(event) { stderr.write(`${JSON.stringify(event)}\n`); },
    });
  }
  stderr.write("Extracting concepts...\n");
  const reportProgress = ({ stage, completed, total, detail }) => stderr.write(`${stage}: ${completed}/${total} batches${detail ? ` (${detail})` : ""}\n`);
  const options = analysisOptionsFromEnv(isDemo ? { AI_CONCURRENCY: "1" } : process.env);
  const detailedConcepts = await measureAnalysisStage("concepts", () => extractConcepts(client, material, reportProgress, options), reportTiming);
  const initialConcepts = mode === "conceptual" ? await measureAnalysisStage("organization", () => organizeConcepts(client, material, detailedConcepts, reportProgress, options), reportTiming) : detailedConcepts;
  stderr.write("Analyzing relations...\n");
  const initialRelations = await measureAnalysisStage("relations", () => analyzeRelations(client, material, initialConcepts, reportProgress, options), reportTiming);
  const localized = await measureAnalysisStage("localization", () => localizeResult(client, {
    mode, concepts: initialConcepts, relations: initialRelations, ...(mode === "conceptual" ? { detailedConcepts } : {}),
  }, { onProgress: reportProgress, validate(value) {
    conceptCollectionSchema.parse({ concepts: value.concepts });
    relationCollectionSchema.parse({ relations: value.relations });
    if (value.detailedConcepts) conceptCollectionSchema.parse({ concepts: value.detailedConcepts });
    validateGraph(value);
  } }), reportTiming);
  const { concepts, relations } = localized.result;
  reportTiming({ kind: "timing", stage: "analysis", outcome: "completed", elapsedMs: Math.round((performance.now() - analysisStartedAt) * 100) / 100 });
  stdout.write(`${JSON.stringify({ ...localized.result, localization: localized.report }, null, 2)}\n`);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const conceptId = isDemo ? "c3" : (await terminal.question("Concept ID to practice: ")).trim();
    const concept = concepts.find((entry) => entry.id === conceptId);
    if (!concept) throw new AiError("INPUT", "Unknown concept ID.");
    const localizedQuestion = await localizeResult(client, await generateQuestion(client, concept, material), { validate: validateQuestion });
    const question = localizedQuestion.result;
    const { status, detected, translated, warning } = localizedQuestion.report;
    stdout.write(`${JSON.stringify({ ...publicQuestion(question), localization: { status, detected, translated, warning } }, null, 2)}\n`);
    const answer = isDemo ? "The requested page is absent from physical memory." : await terminal.question("Your answer: ");
    const localizedEvaluation = await localizeResult(client, await evaluateAnswer(client, concept, material, question, answer), { validate: (value) => evaluationSchema.parse(value) });
    const evaluation = localizedEvaluation.result;
    const localizedPath = await localizeResult(client, await recommendPath(client, { concepts, relations }, conceptId, [{ conceptId, scores: [evaluation.score], recentMistakes: evaluation.weakPoints }]), { validate: (value) => recommendationSchema.parse(value) });
    stdout.write(`${JSON.stringify({ evaluation, path: localizedPath.result, localization: { evaluation: localizedEvaluation.report, path: localizedPath.report } }, null, 2)}\n`);
  } finally { terminal.close(); }
}

try { await main(); }
catch (error) {
  stderr.write(`${error instanceof AiError ? `${error.code}: ${error.message}` : "Experiment failed unexpectedly."}\n`);
  process.exitCode = 1;
}
