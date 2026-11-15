import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createConfiguredClient, analysisOptionsFromEnv, analyzeRelations } from '../apps/api/src/ai/index.ts';
import { combineSubject } from '../apps/api/src/features/workspace/index.mjs';
import { crossMaterialRequests } from '../apps/api/src/ai/relation-analysis/cross-material.ts';
import { partitionRequests, requestCharacters } from '../apps/api/src/ai/core/partition.ts';

// Read the saved graph, never replace it. Network inference requires an explicit --live flag.
const workspace = JSON.parse(await readFile('.learnmap/workspace.json', 'utf8'));
const analyses = new Map(workspace.analyses.map((job) => [job.id, job]));
const subject = workspace.subjects.find((subject) => workspace.analyses.filter((job) => job.subjectId === subject.id && job.status === 'ready').length >= 2);
if (!subject) throw new Error('No saved subject has two completed materials.');
const combined = combineSubject({ ...subject, questions: new Map(), progress: new Map() }, analyses);
const plan = crossMaterialRequests(combined.material, combined.concepts);
const anchors = new Map();
for (const pair of plan.pairs) { const entries = anchors.get(pair.anchor) ?? []; entries.push(pair); anchors.set(pair.anchor, entries); }
const maximumSelection = [...anchors.values()].flatMap((pairs) => pairs.slice(0, 6));
const judgmentBatches = maximumSelection.flatMap((_, index) => index % 12 === 0
  ? partitionRequests(maximumSelection.slice(index, index + 12), plan.judge) : []);
const report = { subject: subject.name, concepts: combined.concepts.length, crossPairs: plan.pairs.length,
  screeningBatches: plan.screeningBatches.length, maximumCandidates: maximumSelection.length,
  exampleJudgmentBatches: judgmentBatches.length,
  maxScreeningCharacters: Math.max(0, ...plan.screeningBatches.map((batch) => requestCharacters(plan.screen(batch)))),
  maxJudgmentCharacters: Math.max(0, ...judgmentBatches.map((batch) => requestCharacters(plan.judge(batch)))),
};
if (process.argv.includes('--live')) {
  const requests = [];
  const events = [];
  const client = createConfiguredClient(process.env, { onEvent: (event) => requests.push(event) });
  const byId = new Map(combined.concepts.map((concept) => [concept.id, concept]));
  const existingRelations = combined.relations.filter((relation) => byId.get(relation.source).sourceLocation.split('/')[0] === byId.get(relation.target).sourceLocation.split('/')[0]);
  const started = performance.now();
  const relations = await analyzeRelations(client, combined.material, combined.concepts, (event) => {
    events.push(event);
    if (event.detail) process.stderr.write(`${event.detail}\n`);
  }, { ...analysisOptionsFromEnv(process.env), concurrency: analysisOptionsFromEnv(process.env).relationConcurrency, crossMaterial: true, existingRelations });
  report.elapsedMs = Math.round(performance.now() - started);
  report.crossRelations = relations.filter((relation) => !existingRelations.includes(relation)).length;
  report.tasks = requests.reduce((summary, event) => {
    const key = `${event.task}/${event.model}`;
    const task = summary[key] ??= { attempts: 0, elapsedMs: 0 };
    task.attempts++; task.elapsedMs += event.elapsedMs ?? 0; return summary;
  }, {});
  await mkdir('.learnmap/benchmarks', { recursive: true });
  await writeFile('.learnmap/benchmarks/cross-material-latest.json', JSON.stringify({ report, events, requests, relations }, null, 2));
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
