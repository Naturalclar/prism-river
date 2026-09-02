import { expect, test, wavWindowPeak } from "./helpers";

/**
 * ピアノロールでの打ち込み（#55）。ドラム（#54）と同じく手ぶらで始められるので、
 * どのテストもファイルを読み込まない。「置いた」だけでなく、書き出した WAV の
 * 中身で**実際に音が出ている**ことを見る。
 */

/** C4（MIDI 60）のステップを押す。既定の長さは 2 ステップ。 */
async function putC4(page: import("@playwright/test").Page, step: number) {
  await page.getByTestId(`roll-60-${step}`).click();
  await expect(page.getByTestId(`roll-60-${step}`)).toHaveAttribute("aria-pressed", "true");
}

async function exportMix(page: import("@playwright/test").Page): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 20_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");
  return file;
}

test("打ち込みを追加すると空のロールが開く", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();

  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("rollpanel")).toBeVisible();
  /* 120BPM の1小節＝2.00 秒。音が無くても尺は保つ。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  await expect(page.getByTestId("roll-60-0")).toHaveAttribute("aria-pressed", "false");
});

test("置いたノートが鳴り、置いていない区間は静か", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  /* 120BPM なので 1ステップ = 0.125s。先頭に C4 を1つだけ置く（長さ2＝0.25s）。 */
  await putC4(page, 0);

  const file = await exportMix(page);
  const head = wavWindowPeak(file, 0, 0.2);
  const gap = wavWindowPeak(file, 0.6, 1.9);
  expect(head).toBeGreaterThan(3000);
  expect(gap).toBeLessThan(head / 10);
});

test("ノートを消すと書き出しからも消える", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 0);
  await putC4(page, 8);

  const before = await exportMix(page);
  expect(wavWindowPeak(before, 1.0, 1.2)).toBeGreaterThan(3000);

  /* 8ステップ目（1.0s）の音だけ外す。 */
  await page.getByTestId("roll-60-8").click();
  await expect(page.getByTestId("roll-60-8")).toHaveAttribute("aria-pressed", "false");

  const after = await exportMix(page);
  expect(wavWindowPeak(after, 0, 0.2)).toBeGreaterThan(3000);
  expect(wavWindowPeak(after, 1.0, 1.2)).toBeLessThan(1000);
});

test("小節を増やすと格子が横に伸びる（ドラムのような繰り返しではない）", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  /* 1小節なので 16 ステップまで。17 個目はまだ無い。 */
  await expect(page.getByTestId("roll-60-15")).toBeVisible();
  await expect(page.getByTestId("roll-60-16")).toHaveCount(0);

  await page.locator("[data-testid=roll-bars]").evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, "2");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await expect(page.getByTestId("roll-60-31")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
});

test("保存してリロードするとノートごと復元される", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 5);

  await page.getByRole("button", { name: "プロジェクトを保存" }).click();
  await expect(page.getByTestId("log")).toContainText("保存しました", { timeout: 15_000 });

  await page.reload();
  await page.getByRole("button", { name: "前回を復元" }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });

  /* ロールを開き直すと、置いた1音だけが残っている（音の正本がノート列なので、
     復元は再レンダーで通っている）。 */
  await page.getByRole("button", { name: /のロール$/ }).click();
  await expect(page.getByTestId("roll-60-5")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("roll-60-0")).toHaveAttribute("aria-pressed", "false");
});
