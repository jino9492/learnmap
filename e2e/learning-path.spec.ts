import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("unstarted subjects expose a path immediately and graph links need no AI recommendation", async ({
  page,
}) => {
  const request = page.request;
  const subject = await (
    await request.post("/api/subjects", { data: { name: "기본 학습 경로" } })
  ).json();
  const job = await (
    await request.post(
      `/api/analyses?filename=lecture.txt&subjectId=${subject.id}`,
      { data: await readFile("examples/lecture.txt") },
    )
  ).json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/analyses/${job.id}`)).json()).status,
    )
    .toBe("ready");
  const view = await (await request.get(`/api/subjects/${subject.id}`)).json();
  expect(view.progress).toEqual([]);
  expect(view.path.steps).toHaveLength(view.graph.concepts.length);
  const target = view.graph.concepts.at(-1);
  let recommendationRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/path")) recommendationRequests++;
  });
  await page.goto(
    `/subjects/${subject.id}/graph?concept=${encodeURIComponent(target.id)}`,
  );
  await page.getByRole("link", { name: "추천 학습 경로 보기" }).click();
  await expect(page.locator("#path-steps .path-step")).toHaveCount(
    view.graph.concepts.length,
  );
  await expect(page.locator("#path-steps .path-step").last()).toContainText(
    target.name,
  );
  await page.getByLabel("목표 개념").selectOption(view.graph.concepts[0].id);
  await expect(page.locator("#path-steps .path-step")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("목표 개념")).toHaveValue(
    view.graph.concepts[0].id,
  );
  expect(recommendationRequests).toBe(0);
});

test("progress adjusts parallel prerequisites, skips mastered steps and reflects completion", async ({
  page,
}) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const snapshot = {
    id,
    name: "이해도 보정",
    materials: [],
    history: [],
    path: null,
    graph: {
      concepts: ["A", "B", "C"].map((id) => ({
        id,
        name: id,
        description: "개념 설명",
        sourceLocation: "page:1",
        evidence: "근거",
      })),
      relations: ["A", "B"].map((source) => ({
        source,
        target: "C",
        type: "PREREQUISITE",
        reason: "선수 관계",
      })),
    },
    progress: [
      { conceptId: "A", score: 100, status: "MASTERED" },
      { conceptId: "B", score: 20, status: "WEAK" },
    ],
  };
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          { id, name: snapshot.name, conceptCount: 3, materialCount: 0 },
        ],
      },
    }),
  );
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto(`/subjects/${id}/learning-path?concept=C`);
  await expect(page.locator("#path-steps strong")).toHaveText(["B", "A", "C"]);
  await expect(
    page.getByRole("link", { name: "학습 시작", exact: true }),
  ).toHaveAttribute("href", `/subjects/${id}/concepts/B/quiz`);
  snapshot.progress = ["A", "B", "C"].map((conceptId) => ({
    conceptId,
    score: 100,
    status: "MASTERED",
  }));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "경로 학습 완료" }),
  ).toBeDisabled();
  await expect(page.locator("#path-steps .path-step")).toHaveCount(3);
});

test("related concepts remain separate from the path and follow target selection", async ({
  page,
}) => {
  const id = "22222222-2222-4222-8222-222222222222";
  const snapshot = {
    id,
    name: "연관 개념",
    materials: [],
    history: [],
    path: null,
    progress: [],
    graph: {
      concepts: ["A", "B", "C", "D", "E"].map((id) => ({
        id,
        name: id,
        description: "개념 설명",
        sourceLocation: "page:1",
        evidence: "근거",
      })),
      relations: [
        { source: "A", target: "B", type: "PREREQUISITE", reason: "선수 관계" },
        { source: "B", target: "C", type: "PREREQUISITE", reason: "선수 관계" },
        {
          source: "D",
          target: "C",
          type: "RELATED",
          reason: "공통 원리를 비교하세요.",
        },
        {
          source: "A",
          target: "D",
          type: "RELATED",
          reason: "기초와 응용을 함께 보세요.",
        },
        { source: "A", target: "B", type: "RELATED", reason: "경로 내 관계" },
      ],
    },
  };
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          { id, name: snapshot.name, conceptCount: 5, materialCount: 0 },
        ],
      },
    }),
  );
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto(`/subjects/${id}/learning-path?concept=C`);
  const section = page.getByRole("region", { name: "같이 보면 좋을 개념들" });
  await expect(page.locator("#path-steps strong")).toHaveText(["A", "B", "C"]);
  await expect(section.locator(".path-companion-card")).toHaveCount(1);
  await expect(section.locator(".path-companion-card > a")).toHaveText(["D"]);
  await expect(section).toContainText("공통 원리를 비교하세요.");
  await expect(section).toContainText("기초와 응용을 함께 보세요.");
  await expect(
    section.getByRole("link", { name: "D", exact: true }),
  ).toHaveAttribute("href", `/subjects/${id}/concepts/D`);
  await page.getByLabel("목표 개념").selectOption("E");
  await expect(section).toContainText("함께 볼 연관 개념이 아직 없습니다.");
  await page.getByLabel("목표 개념").selectOption("");
  await expect(section.locator(".path-companion-card")).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await section.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});
