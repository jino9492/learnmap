import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("first visit uploads files and opens the new learning space", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "학습 자료를 나만의 지식 지도로" }),
  ).toBeVisible();
  await page
    .getByLabel("학습 자료 파일 선택")
    .setInputFiles("examples/lecture.txt");
  await page.getByRole("textbox", { name: "과목명" }).fill("첫 과목");
  await page.getByRole("button", { name: "학습 지도 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "첫 과목 지식 그래프" }),
  ).toBeVisible();
});

test("routes preserve subject and concept across navigation, reload, quiz, and history", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const subject = await (
    await request.post("/api/subjects", { data: { name: "운영체제" } })
  ).json();
  const other = await (
    await request.post("/api/subjects", { data: { name: "자료구조" } })
  ).json();
  const upload = await request.post(
    `/api/analyses?filename=lecture.txt&subjectId=${subject.id}`,
    { data: await readFile("examples/lecture.txt") },
  );
  const job = await upload.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/analyses/${job.id}`)).json()).status,
    )
    .toBe("ready");
  const view = await (await request.get(`/api/subjects/${subject.id}`)).json();
  const concept = view.graph.concepts.at(-1);
  const root = `/subjects/${subject.id}`;
  const detail = `${root}/concepts/${encodeURIComponent(concept.id)}`;
  await page.goto(`${root}/graph?concept=${encodeURIComponent(concept.id)}`);
  await expect(
    page.getByRole("heading", { name: "운영체제 지식 그래프" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "개념 상세 정보" })
      .getByRole("heading", { name: concept.name }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "개념 검색" }).fill(concept.name);
  const graphNode = page.getByRole("button", {
    name: `${concept.name}, 미학습`,
    exact: true,
  });
  await graphNode.press("Shift+ArrowRight");
  const moved = await graphNode.getAttribute("transform");
  await graphNode.press("Enter");
  await expect(page).toHaveURL(new RegExp("q="));
  await page.getByRole("link", { name: "세부 개념 전체 보기" }).click();
  await expect(page).toHaveURL(new RegExp("/concepts/"));
  await page.goBack();
  await expect(graphNode).toHaveAttribute("transform", moved!);
  await page.getByRole("link", { name: "세부 개념 전체 보기" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: concept.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "상세 설명은 필요할 때 작성합니다",
  );
  await page
    .getByRole("button", { name: "상세 설명 작성", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "상세 설명 다시 작성", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "상세 설명 다시 작성", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "이 개념 전체 평가하기" }).click();
  await expect(
    page.getByRole("link", { name: "지식 그래프로", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "문제 생성", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "답안", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "답안", exact: true })
    .fill("요청한 페이지가 물리 메모리에 없을 때 발생합니다.");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "답안", exact: true }),
  ).toHaveValue("요청한 페이지가 물리 메모리에 없을 때 발생합니다.");
  await page.getByRole("link", { name: "지식 그래프로", exact: true }).click();
  await expect(page).toHaveURL(
    `${root}/graph?concept=${encodeURIComponent(concept.id)}`,
  );
  await expect(
    page
      .getByRole("complementary", { name: "개념 상세 정보" })
      .getByRole("heading", { name: concept.name }),
  ).toBeVisible();
  await page.goBack();
  while (
    await page.getByRole("button", { name: "다음 문제", exact: true }).count()
  ) {
    await page.getByRole("button", { name: "다음 문제", exact: true }).click();
    await page
      .getByRole("textbox", { name: "답안", exact: true })
      .fill("요청한 페이지가 물리 메모리에 없을 때 발생합니다.");
  }
  await page.getByRole("button", { name: "전체 답안 제출" }).click();
  await expect(page.getByText("100점", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "지식 그래프로", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "학습 기록", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "나의 학습 기록" }),
  ).toBeVisible();
  await expect(page.getByText("100점", { exact: true }).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByText("100점", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "추천 학습 경로 보기" }).click();
  await page.getByRole("button", { name: "선택한 개념으로 경로 생성" }).click();
  await expect(
    page
      .locator('.path-step[title="선수 개념부터 차례로 복습합니다."]')
      .first(),
  ).toBeVisible();
  await page.goto(`/subjects/${other.id}/graph`);
  await expect(
    page.getByRole("heading", { name: "자료구조 지식 그래프" }),
  ).toBeVisible();
  await page.goto(detail);
  await expect(
    page.getByRole("heading", { name: concept.name, exact: true }),
  ).toBeVisible();
  await page.goto(`${root}/concepts/missing`);
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
  ).toBeVisible();
  await page.goto("/subjects/missing/graph");
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect((await request.get("/api/missing")).status()).toBe(404);
  expect((await request.get("/.env")).status()).toBe(404);
  expect((await request.get("/assets/missing.js")).status()).toBe(404);
});

test("create subject and upload, reanalyze, and delete material from the React UI", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "내 학습 공간" }).click();
  await page.getByRole("button", { name: "과목 추가" }).click();
  const create = page.getByRole("dialog", { name: "새 과목 만들기" });
  await create.getByRole("textbox", { name: "과목명" }).fill("브라우저 테스트");
  await create.getByRole("button", { name: "과목 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "브라우저 테스트 지식 그래프" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "자료", exact: true }).click();
  await page
    .getByRole("button", { name: "자료 추가", exact: true })
    .last()
    .click();
  const upload = page.getByRole("dialog", { name: "학습 자료 추가" });
  await upload
    .locator("input[type=file]")
    .setInputFiles("examples/lecture.txt");
  await upload
    .getByRole("combobox", { name: "개념 정리 방식" })
    .selectOption("detailed");
  await upload.getByRole("button", { name: "자료 추가 및 분석" }).click();
  await page.getByRole("link", { name: "자료", exact: true }).click();
  await expect(
    page.locator("main").getByText("분석 완료", { exact: true }),
  ).toBeVisible({
    timeout: 15000,
  });
  await page.reload();
  await expect(
    page.locator("main").getByText("분석 완료", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "다시 분석", exact: true }).click();
  await expect(
    page.locator("main").getByText("분석 완료", { exact: true }),
  ).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page
    .getByRole("dialog", { name: "학습 자료 삭제" })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "추가한 학습 자료가 없습니다" }),
  ).toBeVisible();
});

test("preserves the original desktop and mobile layout", async ({
  page,
  request,
}) => {
  const subject = await (
    await request.post("/api/subjects", { data: { name: "스타일 검증" } })
  ).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/subjects/${subject.id}/graph`);
  await expect(
    page.getByRole("heading", { name: "스타일 검증 지식 그래프" }),
  ).toBeVisible();
  await expect(page.locator(".topbar nav a")).toHaveCount(3);
  await expect(page.locator(".topbar .search")).toBeVisible();
  await expect(page.locator(".topbar .avatar")).toBeVisible();
  await expect(
    page.locator(".sidebar .material-section .upload-card"),
  ).toBeVisible();
  await expect(page.locator(".map-heading .filters")).toBeVisible();
  await expect(page.locator(".filters .green")).toHaveCSS(
    "background-color",
    "rgb(236, 253, 243)",
  );
  await expect(page.locator(".stats .pill")).toHaveCount(3);
  await expect(
    page
      .locator(".graph-toolbar")
      .getByRole("button", { name: "현재 추천 경로" }),
  ).toBeVisible();
  const desktop = await page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing ${selector}`);
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      header: rect(".topbar"),
      graph: rect(".graph-card"),
      detail: rect(".concept-detail"),
    };
  });
  expect(desktop.header).toEqual({ x: 0, y: 0, width: 1440, height: 72 });
  expect(desktop.graph).toMatchObject({ x: 270, width: 846, height: 746 });
  expect(desktop.graph.y).toBeGreaterThanOrEqual(184);
  expect(desktop.detail).toEqual({ x: 1128, y: 96, width: 288, height: 884 });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(page.locator(".mobile-materials")).toBeVisible();
  await expect(page.locator(".material-section")).toBeHidden();
  await page.locator(".mobile-materials").click();
  await expect(page.locator(".material-section")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".graph-card")).toHaveCSS("height", "540px");
});

test("quiz grades only after all answers and reveals feedback together, resuming failed grading", async ({
  page,
  request,
}) => {
  const subject = await (
    await request.post("/api/subjects", { data: { name: "일괄 채점" } })
  ).json();
  await page.route(`**/api/subjects/${subject.id}`, (route) =>
    route.fulfill({
      json: {
        id: subject.id,
        name: "일괄 채점",
        graph: {
          concepts: [
            {
              id: "batch-concept",
              name: "평가 개념",
              description: "설명",
              sourceLocation: "자료",
              evidence: "근거",
            },
          ],
          relations: [],
        },
        materials: [],
        progress: [],
        path: null,
        history: [],
      },
    }),
  );
  await page.route(`**/api/analyses/${subject.id}/questions`, (route) =>
    route.fulfill({
      json: {
        setId: "batch-set",
        total: 3,
        questions: [1, 2, 3].map((id) => ({
          questionId: `q${id}`,
          topic: `범위 ${id}`,
          question: { type: "ESSAY", question: `질문 ${id}`, options: [] },
        })),
      },
    }),
  );
  const submissions: { questionId: string; answer: string }[] = [];
  let fail = true;
  await page.route(
    `**/api/analyses/${subject.id}/evaluations`,
    async (route) => {
      const input = route.request().postDataJSON();
      submissions.push(input);
      if (input.questionId === "q2" && fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          json: { error: { message: "채점 재시도가 필요합니다." } },
        });
        return;
      }
      await route.fulfill({
        json: {
          evaluation: {
            score: 80,
            feedback: `${input.questionId} 피드백`,
            weakPoints: [],
          },
          progress: {
            conceptId: "batch-concept",
            score: 80,
            status: "MASTERED",
          },
        },
      });
    },
  );
  await page.goto(`/subjects/${subject.id}/concepts/batch-concept/quiz`);
  await page.getByRole("button", { name: "문제 생성", exact: true }).click();
  const answer = page.getByRole("textbox", { name: "답안", exact: true });
  await answer.fill("첫 답안");
  await page.getByRole("button", { name: "다음 문제", exact: true }).click();
  await answer.fill("두 번째 답안");
  await page.getByRole("button", { name: "이전 문제", exact: true }).click();
  await expect(answer).toHaveValue("첫 답안");
  await answer.fill("수정한 첫 답안");
  await page.getByRole("button", { name: "다음 문제", exact: true }).click();
  await expect(answer).toHaveValue("두 번째 답안");
  await page.reload();
  await expect(answer).toHaveValue("두 번째 답안");
  await page.getByRole("button", { name: "다음 문제", exact: true }).click();
  await answer.fill("세 번째 답안");
  expect(submissions).toEqual([]);
  await expect(page.locator(".evaluation")).toHaveCount(0);
  await page.getByRole("button", { name: "전체 답안 제출" }).click();
  await expect(
    page.getByText("채점 재시도가 필요합니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".evaluation")).toHaveCount(0);
  await expect(answer).toBeDisabled();
  await page.reload();
  await expect(answer).toHaveValue("세 번째 답안");
  await page.getByRole("button", { name: "채점 다시 시도" }).click();
  await expect(
    page.getByRole("heading", { name: "전체 채점 결과 및 피드백" }),
  ).toBeVisible();
  for (const id of [1, 2, 3]) {
    await expect(
      page.getByText(`q${id} 피드백`, { exact: true }),
    ).toBeVisible();
  }
  expect(submissions).toEqual([
    { questionId: "q1", answer: "수정한 첫 답안" },
    { questionId: "q2", answer: "두 번째 답안" },
    { questionId: "q2", answer: "두 번째 답안" },
    { questionId: "q3", answer: "세 번째 답안" },
  ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "전체 채점 결과 및 피드백" }),
  ).toBeVisible();
});
