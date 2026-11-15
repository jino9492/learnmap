import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const id = "11111111-1111-4111-8111-111111111111";
const concepts = Array.from({ length: 93 }, (_, index) => ({
  id: `c${index}`,
  name:
    index === 0
      ? "딥러닝"
      : index === 1
        ? "딥러닝의 정의"
        : `학습 개념 ${index}`,
  description: "원문에 근거한 개념 설명입니다.",
  sourceLocation: `file/page:${index + 1}`,
  evidence: "원문 근거입니다.",
}));
const subject = {
  id,
  name: "큰 학습 지도",
  graph: {
    concepts,
    relations: concepts.slice(1).map((concept, index) => ({
      source: concepts[index].id,
      target: concept.id,
      type: "RELATED",
      reason: "관련 원리입니다.",
    })),
    equivalences: [{ memberIds: ["c0", "c1"], reason: "동일한 정의입니다." }],
  },
  materials: [{ id: "file", title: "강의자료.pdf", status: "ready" }],
  progress: [{ conceptId: "c1", score: 80, status: "MASTERED" }],
  history: [],
  path: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          { id, name: subject.name, conceptCount: 93, materialCount: 1 },
        ],
      },
    }),
  );
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({ json: subject }),
  );
});

test("merged file concepts expose all source lessons and prerequisites attached to another original", async ({
  page,
}) => {
  const snapshot = structuredClone(subject);
  for (const index of [0, 1, 2]) {
    snapshot.graph.concepts[index].name = "공통 개념";
    snapshot.graph.concepts[index].description = [
      "정의에 관한 설명입니다.",
      "응용에 관한 설명입니다.",
      "보급 과정에 관한 설명입니다.",
    ][index];
  }
  snapshot.graph.equivalences = [
    {
      memberIds: ["c0", "c1", "c2"],
      reason: "서로 다른 자료에서 설명한 같은 개념입니다.",
    },
  ];
  snapshot.graph.relations.push({
    source: "c3",
    target: "c2",
    type: "PREREQUISITE",
    reason: "이 지식이 필요합니다.",
  });
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto(
    `/subjects/${id}/graph?concept=c0&q=${encodeURIComponent("공통 개념")}`,
  );
  await expect(page.locator("#graph [data-concept]")).toHaveCount(1);
  const sidebar = page.getByRole("complementary", { name: "개념 상세 정보" });
  await expect(
    sidebar.getByLabel("같은 개념의 원본 항목").locator("option"),
  ).toHaveCount(3);
  await expect(
    sidebar.getByRole("link", { name: "학습 개념 3", exact: true }),
  ).toBeVisible();
  await sidebar.getByRole("link", { name: "세부 개념 전체 보기" }).click();
  await expect(page.locator(".concept-section")).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: "선택 항목 평가하기" }),
  ).toHaveAttribute("href", /c0\/quiz$/);
});

test("representative concepts retain all facet lessons and original per-item learning state", async ({
  page,
}) => {
  const names = [
    "전문가 시스템의 지식베이스와 추론",
    "전문가 시스템의 산업 적용",
    "전문가 시스템의 규칙 유지보수와 충돌",
    "전문가 시스템의 지식 획득 병목",
  ];
  const snapshot = structuredClone(subject);
  for (const [index, name] of names.entries())
    snapshot.graph.concepts[index + 2].name = name;
  const graph = {
    ...snapshot.graph,
    coreGroups: [
      {
        name: "전문가 시스템",
        description: "지식을 규칙으로 저장하고 추론하는 시스템입니다.",
        memberIds: ["c2", "c3", "c4", "c5"],
      },
    ],
  };
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        graph,
        progress: [{ conceptId: "c4", score: 80, status: "MASTERED" }],
      },
    }),
  );
  await page.goto(
    `/subjects/${id}/graph?concept=c4&view=all&q=${encodeURIComponent("전문가 시스템")}`,
  );
  await expect(page.locator("#graph [data-concept]")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "전문가 시스템", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("세부 학습 항목 · 원본").locator("option"),
  ).toHaveCount(4);
  await expect(page.locator(".score")).toHaveText("80%");
  await page
    .getByRole("searchbox", { name: "개념 검색" })
    .fill("지식 획득 병목");
  await expect(page.locator("#graph [data-concept]")).toHaveCount(1);
  await page.getByLabel("세부 학습 항목 · 원본").selectOption("c3");
  await expect(page.locator(".score")).toHaveText("아직 평가 전");
  await page.getByRole("link", { name: "세부 개념 전체 보기" }).click();
  await expect(
    page.getByRole("heading", { name: "전문가 시스템", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".concept-section")).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: "선택 항목 평가하기" }),
  ).toHaveAttribute("href", new RegExp("c3/quiz$"));
  await page.goto(
    `/subjects/${id}/graph?view=all&q=${encodeURIComponent("전문가 시스템")}&merge=0`,
  );
  await expect(page.locator("#graph [data-concept]")).toHaveCount(4);
});

test("a 93-item map opens as readable groups, drills down, filters tightly and zooms beyond the old limit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/subjects/${id}/graph`);
  const nodes = page.locator("#graph [data-concept]");
  await expect(nodes).toHaveCount(10);
  await expect(
    page.getByText("10개 탐색 그룹 표시", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('#graph [data-source="__subject__"]')).toHaveCount(
    10,
  );
  await expect(
    page.locator('#graph [data-source="__subject__"]:not(.SUBJECT_LINK)'),
  ).toHaveCount(0);
  await expect(page.locator("#graph .SUBJECT_LINK[marker-end]")).toHaveCount(0);
  const topicLink = page.locator("#graph .SUBJECT_LINK").first();
  const beforeMove = await topicLink.getAttribute("d");
  await page
    .locator('#graph [data-node-key="__subject__"]')
    .press("Shift+ArrowRight");
  await expect(topicLink).not.toHaveAttribute("d", beforeMove!);
  expect((await nodes.first().boundingBox())!.width).toBeGreaterThan(100);
  await mkdir("output/graph-review", { recursive: true });
  await page.screenshot({
    path: "output/graph-review/overview.png",
    fullPage: true,
  });
  await nodes.first().press("Enter");
  await expect(page).toHaveURL(/view=group/);
  await expect(nodes).toHaveCount(10);
  await page.getByRole("searchbox", { name: "개념 검색" }).fill("학습 개념 90");
  await expect(nodes).toHaveCount(1);
  const filtered = (await page.locator("#graph").getAttribute("viewBox"))!
    .split(" ")
    .map(Number);
  expect(filtered[2]).toBeLessThan(1500);
  await page.getByRole("button", { name: "전체 개념", exact: true }).click();
  await expect(nodes).toHaveCount(92);
  await page
    .getByRole("button", { name: "그래프 전체 보기", exact: true })
    .click();
  const fullWidth = Number(
    (await page.locator("#graph").getAttribute("viewBox"))!.split(" ")[2],
  );
  for (let index = 0; index < 16; index++)
    await page
      .getByRole("button", { name: "그래프 확대", exact: true })
      .click();
  const zoomWidth = Number(
    (await page.locator("#graph").getAttribute("viewBox"))!.split(" ")[2],
  );
  expect(zoomWidth).toBeLessThan(fullWidth * 0.2);
});

test("merged display nodes keep original deep links and per-item learning state", async ({
  page,
}) => {
  await page.goto(`/subjects/${id}/graph?concept=c1`);
  const detail = page.getByRole("complementary", { name: "개념 상세 정보" });
  await expect(
    detail.getByRole("heading", { name: "딥러닝의 정의", exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("같은 개념의 원본 항목")).toHaveValue("c1");
  await expect(detail.getByText("이해", { exact: true })).toBeVisible();
  await detail.getByLabel("같은 개념의 원본 항목").selectOption("c0");
  await expect(
    detail.getByRole("heading", { name: "딥러닝", exact: true }),
  ).toBeVisible();
  await detail.getByLabel("같은 개념의 원본 항목").selectOption("c1");
  await detail.getByRole("link", { name: "세부 개념 전체 보기" }).click();
  await expect(page).toHaveURL(/concepts\/c1$/);
  await expect(
    page.getByRole("heading", { name: "딥러닝의 정의", exact: true }),
  ).toBeVisible();
});

test("focus navigation keeps the selected node's screen position and zoom, including revisits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/subjects/${id}/graph?concept=c40&view=all`);
  const graph = page.locator("#graph");
  const node = (conceptId: string) =>
    page.locator(`#graph [data-concept="${conceptId}"]`);
  const snapshot = (conceptId: string) =>
    node(conceptId).evaluate((element) => {
      const node = element as SVGGraphicsElement;
      const matrix = node.getScreenCTM()!;
      const viewport = node.ownerSVGElement!.viewBox.baseVal;
      return {
        x: matrix.e,
        y: matrix.f,
        scale: matrix.a,
        width: viewport.width,
        height: viewport.height,
      };
    });
  const expectPreserved = async (
    conceptId: string,
    before: Awaited<ReturnType<typeof snapshot>>,
  ) => {
    await expect(node(conceptId)).toHaveAttribute("aria-pressed", "true");
    const after = await snapshot(conceptId);
    // SVG transforms use float precision; allow less than 0.005 screen pixels.
    for (const key of ["x", "y"] as const)
      expect(after[key]).toBeCloseTo(before[key], 2);
    for (const key of ["scale", "width", "height"] as const)
      expect(after[key]).toBeCloseTo(before[key], 4);
  };

  await expect(node("c40")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "그래프 확대", exact: true }).click();
  await graph.press("ArrowRight");
  await graph.press("ArrowDown");
  const beforeFocus = await snapshot("c40");
  await page
    .getByRole("button", { name: "선택 개념 주변", exact: true })
    .click();
  await expect(page.locator("#graph [data-concept]")).toHaveCount(3);
  await expectPreserved("c40", beforeFocus);

  for (const conceptId of ["c41", "c40", "c39"]) {
    await node(conceptId).press("Shift+ArrowDown");
    await graph.press("ArrowLeft");
    await node(conceptId).focus();
    const before = await snapshot(conceptId);
    await node(conceptId).press("Enter");
    await expect(page).toHaveURL(new RegExp(`concept=${conceptId}&view=focus`));
    await expectPreserved(conceptId, before);
  }
  await page
    .getByRole("button", { name: "선택 개념 주변", exact: true })
    .click();
  await expect(page.locator("#graph [data-concept]")).toHaveCount(92);
  await expect(
    page.getByRole("button", { name: "전체 개념", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("leaving focus from group views restores the selected concept's group", async ({
  page,
}) => {
  await page.goto(`/subjects/${id}/graph`);
  const nodes = page.locator("#graph [data-concept]");
  await nodes.first().press("Enter");
  await expect(page).toHaveURL(/view=group/);
  const groupId = new URL(page.url()).searchParams.get("group");
  const groupConceptIds = await nodes.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-concept")),
  );
  await nodes.first().press("Enter");
  const focus = page.getByRole("button", {
    name: "선택 개념 주변",
    exact: true,
  });
  for (const fromOverview of [false, true]) {
    if (fromOverview)
      await page
        .getByRole("button", { name: "그룹 개요", exact: true })
        .click();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/view=group/);
    expect(new URL(page.url()).searchParams.get("group")).toBe(groupId);
    expect(
      await nodes.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-concept")),
      ),
    ).toEqual(groupConceptIds);
  }
});

test("mobile group navigation exposes every group without shrinking all concepts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/subjects/${id}/graph`);
  const groups = page.getByRole("navigation", { name: "탐색 그룹 목록" });
  await expect(groups.getByRole("button")).toHaveCount(10);
  await groups.getByRole("button").last().click();
  await expect(page).toHaveURL(/view=group/);
  expect(
    await page.locator("#graph [data-concept]").count(),
  ).toBeLessThanOrEqual(10);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
