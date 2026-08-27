import { expect, test } from "./helpers";

/** マイク録音（フェイクデバイス・権限拒否）。 */

/* フェイクマイク（--use-fake-device-for-media-stream）でトーンが入力される。
   録音開始 → 停止でトラックが1本増え、既存の読み込み経路（decode → push）に乗る。 */
test("マイク録音を停止するとトラックが1本増える", async ({ page }) => {
  await page.getByRole("button", { name: "マイクから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("録音中");

  /* 実時間でしか録れないので、内容が入るぶんだけ待つ。 */
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "録音を停止", exact: true }).click();

  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toContainText("録音 1");
  await expect(page.getByTestId("probe-trk")).toHaveText("1");
  await expect(page.getByTestId("log")).toContainText("録音 1 —");
  await expect(page.getByTestId("clip")).toHaveCount(1);

  /* 録音したトラックもそのまま書き出しに乗る。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

test("マイクの権限が拒否されたら分かるメッセージが出る", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "マイクから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("マイクの使用が許可されませんでした");
  /* 録音状態にはならず、ボタンは再試行できる姿のまま。 */
  await expect(page.getByRole("button", { name: "マイクから録音", exact: true })).toBeVisible();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  /* afterEach の「ページ例外ゼロ」も検証対象: reject を握り損ねると
     unhandled rejection がここで出る。 */
});
