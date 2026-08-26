import { expect, load, makeTone, test, wavWindowPeak } from "./helpers";

/** クリップの編集操作: 選択と削除・移動を除くドラッグ系（トリム・フェード）。 */

test("クリックで選択したトラックを Delete で削除できる", async ({ page }) => {
  await load(page, [makeTone("sel1.wav", 440), makeTone("sel2.wav", 330)]);

  /* クリップのクリックで選択（枠が付く）。 */
  await page.getByTestId("clip").first().click();
  await expect(page.getByTestId("clip").first()).toHaveClass(/selected/);
  await expect(page.getByTestId("track-head").first()).toHaveClass(/selected/);

  /* Delete で選択中のトラックだけ消える。 */
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("track-head")).toContainText("sel2");

  /* 選択が無い状態の Delete では何も起きない。 */
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("track-head")).toHaveCount(1);

  /* 同じトラックの再クリックで選択が外れる。 */
  await page.getByTestId("clip").click();
  await expect(page.getByTestId("clip")).toHaveClass(/selected/);
  await page.getByTestId("clip").click();
  await expect(page.getByTestId("clip")).not.toHaveClass(/selected/);
});

test("クリップの左右端ドラッグでトリムできる", async ({ page }) => {
  await load(page, [makeTone("trim.wav", 440, 3)]);
  const before = await page.getByTestId("clip").boundingBox();
  if (!before) throw new Error("clip not found");

  /* 右端を 70px（既定ズームで 1 秒）左へ → 全長が 2 秒になる。 */
  const y = before.y + before.height / 2;
  await page.mouse.move(before.x + before.width - 4, y);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 4 - 70, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  const trimmed = await page.getByTestId("clip").boundingBox();
  if (!trimmed) throw new Error("clip not found");
  expect(trimmed.width).toBeLessThan(before.width - 60);

  /* 左端を 35px（0.5 秒）右へ → 頭が削れて開始位置がその分ずれる。
     offset が連動するので全長（0.5 + 1.5 = 2 秒）は変わらない。 */
  await page.mouse.move(trimmed.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(trimmed.x + 4 + 35, y, { steps: 5 });
  await page.mouse.up();
  const headTrimmed = await page.getByTestId("clip").boundingBox();
  if (!headTrimmed) throw new Error("clip not found");
  expect(headTrimmed.x - trimmed.x).toBeGreaterThan(30);
  expect(headTrimmed.width).toBeLessThan(trimmed.width - 30);
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");

  /* トリム後も再生と書き出しが通る。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

test("フェードアウトが書き出しに効く", async ({ page }) => {
  await load(page, [makeTone("fade.wav", 440, 2)]);
  const box = await page.getByTestId("clip").boundingBox();
  if (!box) throw new Error("clip not found");

  /* 右上のフェードハンドルを左端までドラッグ → フェードアウト 2 秒。 */
  const hx = box.x + box.width - 3;
  const hy = box.y + 5;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 140, hy, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("log")).toContainText("アウト 2.00s");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  /* 音源は 0.5s ごとに同じ振幅でアタックを打ち直すので、素の書き出しなら
     0.5s 付近と 1.5s 付近のピークはほぼ同じ。線形フェードアウトが効いて
     いれば 1.5s 時点のゲインは 0.25 になり、比がはっきり開く。 */
  const head = wavWindowPeak(file, 0.45, 0.65);
  const tail = wavWindowPeak(file, 1.45, 1.65);
  expect(head).toBeGreaterThan(3000);
  expect(tail).toBeLessThan(head * 0.5);
});
