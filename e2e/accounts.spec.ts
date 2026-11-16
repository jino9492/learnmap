import { test, expect } from "@playwright/test";

test("guest maps merge on signup and login from another browser", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const email = `sync-${Date.now()}@example.com`;
  const password = "my-learning-password";
  try {
    const page = await first.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
    const created = await first.request.post("/api/subjects", {
      data: { name: "첫 번째 기기" },
    });
    const { id } = await created.json();
    await page.goto(`/subjects/${id}/graph`);
    await page.getByRole("button", { name: "로그인" }).click();
    await page
      .getByRole("button", { name: "계정이 없나요? 계정 만들기" })
      .click();
    await page.getByRole("textbox", { name: "이메일" }).fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "계정 만들기" }).click();
    await expect(
      page.getByRole("button", { name: "내 계정", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "내 학습 공간" }),
    ).toHaveAttribute("href", `/subjects/${id}/graph`);

    const otherPage = await second.newPage();
    await otherPage.goto("/");
    const another = await second.request.post("/api/subjects", {
      data: { name: "두 번째 기기" },
    });
    const { id: otherId } = await another.json();
    await otherPage
      .getByRole("button", { name: "로그인", exact: true })
      .click();
    await otherPage.getByRole("textbox", { name: "이메일" }).fill(email);
    await otherPage
      .getByLabel("비밀번호", { exact: true })
      .fill("incorrect-password");
    await otherPage
      .getByRole("dialog", { name: "로그인", exact: true })
      .getByRole("button", { name: "로그인", exact: true })
      .click();
    await expect(otherPage.getByRole("alert")).toContainText(
      "이메일 또는 비밀번호가 일치하지 않습니다.",
    );
    await otherPage.getByLabel("비밀번호", { exact: true }).fill(password);
    await otherPage
      .getByRole("dialog", { name: "로그인", exact: true })
      .getByRole("button", { name: "로그인", exact: true })
      .click();
    await expect(
      otherPage.getByRole("button", { name: "내 계정", exact: true }),
    ).toBeVisible();
    const workspace = await (await second.request.get("/api/workspace")).json();
    expect(
      workspace.subjects.map((subject: { id: string }) => subject.id).sort(),
    ).toEqual([id, otherId].sort());
    await otherPage.goto(`/subjects/${id}/graph`);
    await expect(
      otherPage.getByRole("heading", { name: "첫 번째 기기 지식 그래프" }),
    ).toBeVisible();
    await otherPage
      .getByRole("button", { name: "내 계정", exact: true })
      .click();
    await expect(otherPage.getByText(email, { exact: true })).toBeVisible();
    await otherPage
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await expect(
      otherPage.getByRole("button", { name: "로그인" }),
    ).toBeVisible();
    expect(
      (await (await second.request.get("/api/workspace")).json()).subjects,
    ).toEqual([]);
    expect((await first.request.get(`/api/subjects/${id}`)).status()).toBe(200);
  } finally {
    await first.close();
    await second.close();
  }
});

test("login and signup dialogs align fields and actions on desktop and mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["로그인", "계정 만들기"]) {
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeVisible();
      const modal = await dialog.boundingBox();
      const form = await dialog.locator("form").boundingBox();
      const email = await dialog
        .getByLabel("이메일", { exact: true })
        .boundingBox();
      const password = await dialog
        .getByLabel("비밀번호", { exact: true })
        .boundingBox();
      const submit = await dialog
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(modal!.x).toBeGreaterThanOrEqual(0);
      expect(modal!.x + modal!.width).toBeLessThanOrEqual(width);
      // Equal side padding and full-width inputs prevent the old empty right column.
      expect(
        Math.abs(
          form!.x -
            modal!.x -
            (modal!.x + modal!.width - form!.x - form!.width),
        ),
      ).toBeLessThan(1);
      expect(email!.width).toBeCloseTo(form!.width, 0);
      expect(password!.width).toBeCloseTo(email!.width, 0);
      expect(password!.x).toBe(email!.x);
      expect(submit!.x + submit!.width).toBeCloseTo(email!.x + email!.width, 0);
      const labels = dialog.locator(".account-fields label");
      const first = await labels.nth(0).boundingBox();
      const second = await labels.nth(1).boundingBox();
      expect(second!.y - first!.y - first!.height).toBe(16);
      await page.screenshot({
        path: `output/account-${name === "로그인" ? "login" : "signup"}-${width}.png`,
      });
      await dialog
        .getByRole("button", {
          name:
            name === "로그인"
              ? "계정이 없나요? 계정 만들기"
              : "이미 계정이 있나요? 로그인",
          exact: true,
        })
        .click();
    }
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeFocused();
});

test("saved local spaces can be reopened without an account", async ({
  page,
}) => {
  let restored = false;
  const id = "11111111-2222-3333-4444-555555555555";
  await page.route("**/api/account", (route) =>
    route.fulfill({ json: { user: null, legacySubjects: restored ? 0 : 2 } }),
  );
  await page.route("**/api/account/restore", (route) => {
    expect(route.request().method()).toBe("POST");
    restored = true;
    return route.fulfill({
      json: { user: null, restoredSubjectId: id, legacySubjects: 0 },
    });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        subjects: restored
          ? [{ id, name: "기존 학습 지도", conceptCount: 0, materialCount: 0 }]
          : [],
      },
    }),
  );
  await page.route(`**/api/subjects/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: "기존 학습 지도",
        graph: { concepts: [], relations: [] },
        materials: [],
        history: [],
        progress: [],
        path: null,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("complementary", { name: "이전 학습 공간" }),
  ).toContainText("2개");
  await page.getByRole("button", { name: "저장된 학습 공간 열기" }).click();
  await expect(
    page.getByRole("heading", { name: "기존 학습 지도 지식 그래프" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
});

test("landing header keeps actions together at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  for (const width of [1542, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const start = await page
      .getByRole("link", { name: "시작하기 ↗", exact: true })
      .boundingBox();
    const login = await page
      .getByRole("button", { name: "로그인", exact: true })
      .boundingBox();
    expect(start).not.toBeNull();
    expect(login).not.toBeNull();
    expect(Math.abs(start!.y - login!.y)).toBeLessThanOrEqual(2);
    expect(login!.x - (start!.x + start!.width)).toBeLessThanOrEqual(12);
    expect(login!.x + login!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `output/header-${width}.png` });
  }
});
