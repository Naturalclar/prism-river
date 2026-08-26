import { expect, load, makeTone, setRange, test } from "./helpers";

/** プロジェクトのローカル保存・復元・削除（#18）。 */

/* #18: プロジェクトの保存・復元。メタは localStorage、音声は IndexedDB。 */
test("プロジェクトを保存してリロード後に復元できる", async ({ page }) => {
  await load(page, [makeTone("keep1.wav", 440), makeTone("keep2.wav", 330, 3)]);

  /* 音量を 50 に変更（range は fill が効かないので setZoom と同じ手で入れる）。 */
  await page.getByLabel("keep1 の音量").evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");

  /* クリップを右へ 140px（既定ズーム 70px/s で 2 秒）動かす → 全長 4 秒。 */
  const box = await page.getByTestId("clip").first().boundingBox();
  if (!box) throw new Error("clip not found");
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, cy, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");

  /* keep1 に EQ LOW -6dB とコンプ ON を設定（#35: fx も保存対象）。 */
  await page.getByRole("button", { name: "keep1 のエフェクト", exact: true }).click();
  await setRange(page, "[data-testid=fx-low]", -6);
  await page.getByTestId("fx-comp").click();
  await expect(page.getByTestId("fxpanel")).toContainText("-6 dB");

  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  /* リロード → 復元提案が出る → 復元でトラック・名前・音量・開始位置が戻る。 */
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByTestId("log")).toContainText("前回保存したプロジェクト");
  await page.getByRole("button", { name: "前回を復元", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  await expect(page.getByTestId("track-head").first()).toContainText("keep1");
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
  await expect(page.getByTestId("probe-dec")).toContainText("ms");

  /* fx も復元されている（パネルの表示とコンプの ON 状態で確認）。 */
  await page.getByRole("button", { name: "keep1 のエフェクト", exact: true }).click();
  await expect(page.getByTestId("fxpanel")).toContainText("-6 dB");
  await expect(page.getByTestId("fx-comp")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "エフェクトを閉じる", exact: true }).click();

  /* 復元後も再生と書き出しが通る。 */
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect
    .poll(async () => page.getByTestId("clock-pos").textContent(), { timeout: 5000 })
    .not.toBe("00:00.00");
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

test("保存データを消すとリロード後は素の初期状態に戻る", async ({ page }) => {
  await load(page, [makeTone("wipe.wav", 440)]);
  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  await page.getByRole("button", { name: "保存データを消す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("保存データを削除しました");

  await page.reload();
  await expect(page.getByRole("button", { name: "前回を復元" })).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
  await expect(page.getByTestId("log")).not.toContainText("前回保存したプロジェクト");
});
