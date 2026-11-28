import { test, expect } from "@playwright/test";

test("filename and analysis filters include failed reanalysis with retained results", async ({
  page,
}) => {
  const subject = {
    id: "materials-filters",
    name: "운영체제",
    graph: { concepts: [], relations: [] },
    materials: [
      { id: "ready", title: "Lecture.pdf", status: "ready", error: null },
      { id: "failed", title: "Notes.txt", status: "failed", error: {} },
      {
        id: "retained",
        title: "Lecture notes.md",
        status: "ready",
        error: { message: "Reanalysis failed" },
      },
      {
        id: "queued",
        title: "Week 2.pdf",
        status: "queued",
        analysisProgress: { stage: "queued", label: "분석 대기", percent: 0 },
      },
    ],
    progress: [],
    history: [],
    path: null,
  };
  await page.route(`**/api/subjects/${subject.id}`, (route) =>
    route.fulfill({ json: subject }),
  );
  await page.route("**/api/materials/retained/analyze", (route) => {
    expect(route.request().method()).toBe("POST");
    subject.materials = subject.materials.map((material) =>
      material.id === "retained" ? { ...material, error: null } : material,
    );
    return route.fulfill({ json: { id: "retained" } });
  });

  await page.goto(`/subjects/${subject.id}/materials`);
  const cards = page.getByRole("article");
  const search = page.getByRole("searchbox", { name: "파일명 검색" });
  const status = page.getByRole("combobox", { name: "분석 상태" });

  await expect(cards).toHaveCount(4);
  await status.selectOption("active");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Week 2.pdf");

  await status.selectOption("failed");
  await expect(cards).toHaveCount(2);
  await search.fill("  LECTURE  ");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Lecture notes.md");
  await expect(cards.first().getByRole("status")).toHaveText("분석 실패");
  await cards.first().getByRole("button", { name: "다시 분석" }).click();
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "조건에 맞는 학습 자료가 없습니다" }),
  ).toBeVisible();

  await status.selectOption("ready");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Lecture.pdf");
  await expect(cards.last()).toContainText("Lecture notes.md");

  await search.fill("missing");
  await page.getByRole("button", { name: "검색 및 필터 초기화" }).click();
  await expect(search).toHaveValue("");
  await expect(status).toHaveValue("all");
  await expect(cards).toHaveCount(4);
});
