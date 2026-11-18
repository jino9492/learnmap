import { test, expect } from "@playwright/test";

test("interactive loading dialog shows queue wait and resumes automatically", async ({
  page,
}) => {
  let waiting = true;
  await page.route("**/api/analyses/queue-dialog", (route) =>
    route.fulfill({
      json: {
        queueState: waiting
          ? { waiting: 1, active: 0 }
          : { waiting: 0, active: 1 },
      },
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/loading.js";
    const { createAiLoading } = await import(path);
    void createAiLoading()(
      "questions",
      () =>
        new Promise<void>((resolve) => {
          (
            window as unknown as { finishQueueTest: () => void }
          ).finishQueueTest = resolve;
        }),
      "/api/analyses/queue-dialog",
    );
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "대기 중", exact: true }),
  ).toBeVisible();
  waiting = false;
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", {
        name: "학습 자료를 바탕으로 문제를 생성하고 있어요",
      }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { finishQueueTest: () => void }).finishQueueTest(),
  );
  await expect(page.locator("dialog.ai-loading")).not.toBeVisible();
});

test("an already-running server without the progress field uses its live analysis log", async ({
  page,
}) => {
  let completed = 42;
  let fail = false;
  let linking = false;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ json: { subjects: [] } }),
  );
  await page.route("**/api/subjects/legacy-progress", (route) =>
    route.fulfill({
      json: {
        id: "legacy-progress",
        name: "진행률 확인",
        graph: { concepts: [], relations: [] },
        progress: [],
        history: [],
        path: null,
        materials: [
          {
            id: "legacy-material",
            title: "lecture02.pdf",
            status: "analyzing_relations",
          },
        ],
      },
    }),
  );
  await page.route("**/api/analyses/legacy-material", async (route) => {
    await pending;
    await route.fulfill(
      fail
        ? { status: 503, json: { error: { message: "Unavailable" } } }
        : {
            json: {
              status: "analyzing_relations",
              mode: "detailed",
              events: [
                ...(linking
                  ? [
                      {
                        kind: "progress",
                        stage: "relations",
                        completed: 90,
                        total: 90,
                      },
                      {
                        kind: "timing",
                        stage: "localization",
                        outcome: "completed",
                      },
                    ]
                  : []),
                { kind: "progress", stage: "relations", completed, total: 90 },
              ],
            },
          },
    );
  });
  await page.goto("/subjects/legacy-progress/graph");
  const bar = page.getByRole("progressbar", {
    name: "lecture02.pdf 분석 진행률",
    exact: true,
  });
  await expect(page.getByText("진행률 확인 중", { exact: true })).toBeVisible();
  await expect(bar).not.toHaveAttribute("value");
  await expect(page.getByText("분석 준비 중", { exact: true })).toHaveCount(0);
  release();
  await expect(bar).toHaveAttribute("value", "66");
  await expect(
    page.getByText("lecture02.pdf · 개념 관계 분석·검증 · 42/90묶음 처리"),
  ).toBeVisible();
  completed = 60;
  await expect(bar).toHaveAttribute("value", "71");
  linking = true;
  await expect(bar).toHaveAttribute("value", "95");
  fail = true;
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await expect(
    page.getByText("진행 상태 연결 지연 · 다시 확인 중"),
  ).toBeVisible({ timeout: 10000 });
  await expect(bar).toHaveAttribute("value", "95");
});

test("generation progress only reflects the active material across polling and reload", async ({
  page,
}) => {
  let percent = 0;
  let status = "extracting_concepts";
  let secondActive = false;
  let waiting = false;
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          {
            id: "progress-test",
            name: "진행률 테스트",
            conceptCount: 0,
            materialCount: 2,
          },
        ],
      },
    }),
  );
  await page.route("**/api/subjects/progress-test", (route) =>
    route.fulfill({
      json: {
        id: "progress-test",
        name: "진행률 테스트",
        graph: { concepts: [], relations: [] },
        progress: [],
        history: [],
        path: null,
        materials: [
          {
            id: "done",
            title: "완료.txt",
            status: secondActive ? "localizing" : "ready",
            analysisProgress: {
              stage: secondActive ? "localizing" : "ready",
              label: secondActive ? "한국어 설명 정리" : "완료",
              percent: secondActive ? 80 : 100,
            },
          },
          {
            id: "active",
            title: "분석.txt",
            status,
            analysisProgress: {
              stage: status,
              label: waiting
                ? "대기 중 · 개념 추출"
                : status === "saving"
                  ? "학습 지도 저장"
                  : "개념 추출",
              waiting,
              percent,
              completed: 1,
              total: 2,
            },
          },
        ],
      },
    }),
  );
  await page.goto("/subjects/progress-test/graph");
  const overall = page.getByRole("progressbar", {
    name: "학습 지도 생성 진행률",
    exact: true,
  });
  const material = page.getByRole("progressbar", {
    name: "분석.txt 분석 진행률",
    exact: true,
  });
  // Previously the completed material made a new task appear stuck at 50%.
  await expect(overall).toHaveCount(0);
  await expect(material).toHaveAttribute("value", "0");
  await expect(
    page.locator(".analysis-banner").getByRole("progressbar"),
  ).toHaveCount(1);
  percent = 30;
  await expect(material).toHaveAttribute("value", "30");
  await expect(
    page.getByText("분석.txt · 개념 추출 · 1/2묶음 처리"),
  ).toBeVisible();
  secondActive = true;
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await expect(
    page.locator(".analysis-banner").getByRole("progressbar"),
  ).toHaveCount(2);
  await expect(material).toHaveAttribute("value", "30");
  await expect(
    page.getByRole("progressbar", {
      name: "완료.txt 분석 진행률",
      exact: true,
    }),
  ).toHaveAttribute("value", "80");
  secondActive = false;
  waiting = true;
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await expect(
    page
      .locator(".material-list")
      .getByText("대기 중 · 개념 추출", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("분석.txt · 대기 중 · 개념 추출 · 1/2묶음 처리"),
  ).toBeVisible();
  await expect(material).toHaveAttribute("value", "30");
  await page.reload();
  await expect(
    page
      .locator(".material-list")
      .getByText("대기 중 · 개념 추출", { exact: true }),
  ).toBeVisible();
  waiting = false;
  percent = 99;
  status = "saving";
  await expect(material).toHaveAttribute("value", "99");
  await expect(
    page.getByText("대기 중 · 개념 추출", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(material).toHaveAttribute("value", "99");
  status = "ready";
  percent = 100;
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await expect(page.locator(".analysis-banner")).toHaveCount(0);
});
