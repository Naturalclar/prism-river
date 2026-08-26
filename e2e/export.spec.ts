import { readFileSync, statSync } from "node:fs";
import { expect, load, makeTone, test } from "./helpers";

/** ミックスの書き出し（WAV / webm）と保存経路の失敗からの復帰。 */

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

/* webm はオフラインの一括レンダーと違い、実時間で再生しながら録る（仕様）。
   テスト音源を短く保つのはそのため。 */
test("webm 書き出しで Opus のファイルが降りてくる", async ({ page }) => {
  await load(page, [makeTone("wm.wav", 440, 2)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "webm で書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("webm を書き出しました", {
    timeout: 20_000,
  });

  const d = await download;
  expect(d.suggestedFilename()).toBe("prism-river-mix.webm");
  const file = await d.path();
  if (!file) throw new Error("download path unavailable");
  expect(statSync(file).size).toBeGreaterThan(1000);
  /* WebM (Matroska) のマジックナンバー 0x1A45DFA3 で始まっている。 */
  const head = readFileSync(file).subarray(0, 4);
  expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

  await expect(page.getByTestId("probe-webm")).toContainText("実時間");
});
