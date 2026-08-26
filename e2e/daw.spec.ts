import { expect, test, type Page } from "@playwright/test";
import { makeTone } from "./fixture";

/** 読み込み〜再生〜書き出しまで、v0 で実機確認したのと同じ道筋を通す。 */

async function load(page: Page, files: string[]) {
  await page.setInputFiles("[data-testid=picker]", files);
  await expect(page.getByTestId("track-head")).toHaveCount(files.length);
}

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
});

/* どのテストでもページ例外ゼロを要求する。 */
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("ファイルを読み込むとトラックとクリップが増え、計測値が埋まる", async ({ page }) => {
  await load(page, [makeTone("a.wav", 440), makeTone("b.wav", 330, 3)]);

  await expect(page.getByTestId("clip")).toHaveCount(2);
  await expect(page.getByTestId("probe-trk")).toHaveText("2");
  await expect(page.getByTestId("probe-sr")).toContainText("Hz");
  await expect(page.getByTestId("probe-ram")).toContainText("MB");
  await expect(page.getByTestId("probe-dec")).toContainText("ms");
  /* 長い方（3秒）が全長になる。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");
});

test("再生するとプレイヘッドと時計が進む", async ({ page }) => {
  await load(page, [makeTone("play.wav", 440, 3)]);

  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect
    .poll(async () => page.getByTestId("clock-pos").textContent(), { timeout: 5000 })
    .not.toBe("00:00.00");

  const x = async () => {
    const t = await page.getByTestId("needle").evaluate((el) => getComputedStyle(el).transform);
    return t === "none" ? 0 : Number.parseFloat(t.split(",")[4] ?? "0");
  };
  const before = await x();
  await expect.poll(x, { timeout: 5000 }).toBeGreaterThan(before);

  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "再生", exact: true })).toBeVisible();
});

test("停止すると先頭に戻る", async ({ page }) => {
  await load(page, [makeTone("stop.wav", 440, 3)]);
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect.poll(async () => page.getByTestId("clock-pos").textContent()).not.toBe("00:00.00");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByTestId("clock-pos")).toHaveText("00:00.00");
});

test("ミックスを書き出すとオフラインレンダーの計測値が出る", async ({ page }) => {
  await load(page, [makeTone("mix1.wav", 440), makeTone("mix2.wav", 550)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();

  await expect(page.getByTestId("probe-off")).toContainText("ms", { timeout: 15_000 });
  await expect(page.getByTestId("log")).toContainText("書き出しました");
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");

  /* レンダーは実時間より十分速いこと（v0 の実測は約323倍速）。 */
  const ms = Number.parseFloat((await page.getByTestId("probe-off").textContent()) ?? "0");
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(2000);
});

/* 保存経路が失敗しても bouncing が戻り、ボタンが使える状態に復帰する回帰。
   （Artifact ビューアで capability 取得が reject するケースの再現） */
test("保存に失敗しても書き出しボタンは無効のままにならない", async ({ page }) => {
  await page.addInitScript(() => {
    window.claude = { use: () => Promise.reject(new Error("downloads unavailable")) };
  });
  await page.goto("/");
  await load(page, [makeTone("stuck.wav", 440)]);

  const bounce = page.getByRole("button", { name: "ミックスを書き出す", exact: true });
  await bounce.click();
  await expect(page.getByTestId("probe-off")).toContainText("ms", { timeout: 15_000 });
  await expect(bounce).toBeEnabled();
  await expect(page.getByTestId("log")).toContainText("ファイル保存が使えない");
  /* afterEach の「ページ例外ゼロ」も本テストの検証対象:
     修正前は use() の reject が unhandled rejection になっていた。 */
});

test("トラックを消すと空の案内に戻る", async ({ page }) => {
  await load(page, [makeTone("gone.wav", 440)]);
  await page.getByRole("button", { name: /削除/ }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
});
