import { readFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { createDemoServer } from "../apps/api/src/demo-server.mjs";
import {
  combineSubject,
  learningProgress,
} from "../apps/api/src/features/workspace/index.mjs";

// Local visual QA only. Never call a model or write to the user's saved workspace.
const saved = JSON.parse(await readFile(".learnmap/workspace.json", "utf8"));
const analyses = new Map(saved.analyses.map((job) => [job.id, job]));
const subject = saved.subjects
  .map((subject) => ({
    ...subject,
    progress: new Map(subject.progress),
    questions: new Map(subject.questions),
  }))
  .find((subject) => combineSubject(subject, analyses).concepts.length > 24);
if (!subject) throw new Error("No saved large graph to preview.");
const combined = combineSubject(subject, analyses);
const response = {
  id: subject.id,
  name: subject.name,
  graph: {
    concepts: combined.concepts,
    relations: combined.relations,
    equivalences: combined.equivalences,
    coreGroups: combined.coreGroups,
  },
  materials: combined.materials,
  progress: [...subject.progress.values()].map(learningProgress),
  history: subject.history,
  path: subject.path,
};
const server = createDemoServer({
  env: {},
  clientFactory: () => ({
    async generate() {
      throw new Error("Model calls are disabled for previews.");
    },
  }),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          {
            id: subject.id,
            name: subject.name,
            conceptCount: combined.concepts.length,
            materialCount: combined.materials.length,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/subjects/${subject.id}`, (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto(
    `http://127.0.0.1:${server.address().port}/subjects/${subject.id}/graph`,
  );
  await page.locator("#graph [data-concept]").first().waitFor();
  await mkdir("output/graph-review", { recursive: true });
  await page.screenshot({
    path: "output/graph-review/current-overview.png",
    fullPage: true,
  });
  const groups = await page.locator("#graph [data-concept]").count();
  await page.locator("#graph [data-concept]").first().press("Enter");
  await page.waitForURL(/view=group/);
  await page.waitForFunction(() => {
    const id = document.querySelector('#graph [data-concept]')?.getAttribute('data-concept');
    return id && !id.startsWith('group:');
  });
  await page.locator("#graph [data-concept]").first().press("Enter");
  await page.waitForURL(/concept=/);
  await page.screenshot({
    path: "output/graph-review/current-group.png",
    fullPage: true,
  });
  const groupNodes = await page.locator("#graph [data-concept]").count();
  await page.getByRole("button", { name: "전체 개념", exact: true }).click();
  await page.getByRole("button", { name: "그래프 전체 보기", exact: true }).click();
  await page.screenshot({ path: "output/graph-review/current-all.png", fullPage: true });
  const representative = combined.coreGroups.find((group) => group.name === "전문가 시스템");
  if (representative) {
    await page.goto(`http://127.0.0.1:${server.address().port}/subjects/${subject.id}/graph?view=all&concept=${encodeURIComponent(representative.memberIds[0])}&q=${encodeURIComponent(representative.name)}`);
    await page.getByRole("heading", { name: representative.name, exact: true }).waitFor();
    await page.screenshot({ path: "output/graph-review/current-core-concept.png", fullPage: true });
    await page.getByRole("link", { name: "세부 개념 전체 보기" }).click();
    await page.getByRole("heading", { name: representative.name, exact: true }).waitFor();
    await page.screenshot({ path: "output/graph-review/current-core-details.png", fullPage: true });
  }
  process.stdout.write(
    `${JSON.stringify({ originalConcepts: combined.concepts.length, displayedGroups: groups, groupNodes, outputs: ["output/graph-review/current-overview.png", "output/graph-review/current-group.png"] })}\n`,
  );
} finally {
  await browser.close();
  const stopped = once(server, "close");
  server.close();
  server.closeAllConnections();
  await stopped;
}
