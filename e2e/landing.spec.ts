import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const subject = {
  id: "landing-subject",
  name: "나의 과목",
  graph: { concepts: [], relations: [] },
  materials: [],
  progress: [],
  history: [],
  path: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: [
          {
            id: subject.id,
            name: subject.name,
            conceptCount: 0,
            materialCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/subjects/${subject.id}`, (route) =>
    route.fulfill({ json: subject }),
  );
});

test("returning visitors see the landing page and upload into their existing space", async ({
  page,
}) => {
  const uploads: URL[] = [];
  await page.route("**/api/analyses?*", (route) => {
    uploads.push(new URL(route.request().url()));
    return route.fulfill({ json: { id: "analysis-id" } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "학습 자료를 나만의 지식 지도로" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "학습 지도 만들기" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "내 학습 공간" }),
  ).toHaveAttribute("href", `/subjects/${subject.id}/graph`);
  await page
    .getByLabel("학습 자료 파일 선택")
    .setInputFiles("examples/lecture.txt");
  await page
    .getByRole("combobox", { name: "개념 정리 방식" })
    .selectOption("detailed");
  await page.getByRole("button", { name: "학습 지도 만들기" }).click();
  await expect(page).toHaveURL(`/subjects/${subject.id}/graph`);
  expect(uploads).toHaveLength(1);
  expect(uploads[0].searchParams.get("subjectId")).toBe(subject.id);
  expect(uploads[0].searchParams.get("mode")).toBe("detailed");
  await page.getByRole("link", { name: "LearnMap 홈" }).click();
  await expect(page).toHaveURL("/");
});

test("invalid files are rejected and partial failures retry only failed uploads", async ({
  page,
}) => {
  const uploads: string[] = [];
  let fail = true;
  await page.route("**/api/analyses?*", (route) => {
    const filename = new URL(route.request().url()).searchParams.get(
      "filename",
    )!;
    uploads.push(filename);
    return route.fulfill(
      filename === "second.md" && fail
        ? { status: 500, json: { error: "일시적인 업로드 오류" } }
        : { json: { id: "analysis-id" } },
    );
  });
  await page.goto("/");
  const input = page.getByLabel("학습 자료 파일 선택");
  await input.setInputFiles({
    name: "slides.pptx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.getByRole("alert")).toContainText("PDF, TXT, Markdown");
  await input.setInputFiles([
    {
      name: "first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("첫 번째 자료"),
    },
    {
      name: "second.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("두 번째 자료"),
    },
  ]);
  await page.getByRole("button", { name: "학습 지도 만들기" }).click();
  await expect(page.getByRole("alert")).toContainText("second.md");
  await expect(
    page.getByRole("list", { name: "선택한 파일" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(page).toHaveURL("/");
  fail = false;
  await page.getByRole("button", { name: "학습 지도 만들기" }).click();
  await expect(page).toHaveURL(`/subjects/${subject.id}/graph`);
  expect(uploads).toEqual(["first.txt", "second.md", "second.md"]);
});

test("desktop and mobile layouts keep upload controls within the viewport", async ({
  page,
}) => {
  await mkdir("output/landing-review", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "파일 선택하기" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "내 학습 공간" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `output/landing-review/${width}.png`,
      fullPage: true,
    });
  }
});

for (const view of ["graph", "materials"]) {
  test(`learning space upload accepts repeated file drops from ${view}`, async ({
    page,
  }) => {
    const uploads: string[] = [];
    await page.route("**/api/analyses?*", (route) => {
      uploads.push(
        new URL(route.request().url()).searchParams.get("filename")!,
      );
      return route.fulfill({ json: { id: "analysis-id" } });
    });
    await page.goto(`/subjects/${subject.id}/${view}`);
    await page
      .getByRole("button", { name: "자료 추가", exact: true })
      .last()
      .click();
    const dialog = page.getByRole("dialog", { name: "학습 자료 추가" });
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(["첫 번째 자료"], "dropped.txt", {
          type: "text/plain",
          lastModified: 1,
        }),
      );
      return data;
    });
    await dialog.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(dialog.locator(".drop-zone")).toHaveClass(/dragging/);
    // Dropping on the title is also supported, beyond the highlighted zone.
    await dialog
      .getByRole("heading")
      .dispatchEvent("drop", { dataTransfer: transfer });
    await expect(dialog.locator(".drop-zone")).not.toHaveClass(/dragging/);
    await expect(dialog.locator("#file-name")).toContainText(
      "1개 선택 · dropped.txt",
    );
    await dialog.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(dialog.locator("#file-name")).toContainText("1개 선택");
    await dialog
      .locator("input[type=file]")
      .setInputFiles({
        name: "extra.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("추가 자료"),
      });
    await expect(dialog.locator("#file-name")).toContainText("2개 선택");
    const invalid = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["invalid"], "slides.pptx"));
      return data;
    });
    await dialog.dispatchEvent("drop", { dataTransfer: invalid });
    await expect(dialog.getByRole("alert")).toContainText("PDF, TXT, Markdown");
    await expect(dialog.locator("#file-name")).toContainText("2개 선택");
    await dialog.getByRole("button", { name: "자료 추가 및 분석" }).click();
    await expect(dialog).not.toBeVisible();
    expect(uploads).toEqual(["dropped.txt", "extra.md"]);
    await transfer.dispose();
    await invalid.dispose();
  });
}
