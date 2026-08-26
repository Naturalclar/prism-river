import { expect, load, makeTone, setRange, test, tilePixelSum } from "./helpers";

/** 波形とルーラーの canvas 描画（タイル分割・テーマ追従）。 */

/* 全幅 1 枚の canvas は一辺上限（Chromium 65535 デバイス px）を超えると
   黙って白紙になる回帰。170秒 × 400px/s = 68,000px で上限を踏む。 */
test("長尺トラックを高ズームにしても波形が消えない", async ({ page }) => {
  await load(page, [makeTone("long.wav", 440, 170)]);
  await setRange(page, "#zoom", 400);

  /* クリップはタイルに割られ、各タイルは上限に収まる幅（8192px 以下）。 */
  const widths = await page
    .locator("[data-testid=clip] canvas")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(widths.length).toBeGreaterThan(1);
  expect(Math.max(...widths)).toBeLessThanOrEqual(8192);
  /* タイルを合わせるとクリップ全幅（約 170s × 400px/s。デコード時の
     リサンプルで数 px ずれることがある）を隙間なく覆っている。 */
  const clipW = await page
    .getByTestId("clip")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(widths.reduce((a, b) => a + b, 0))).toBe(Math.round(clipW));
  expect(clipW).toBeGreaterThan(65535);

  /* 見えている先頭タイルに波形が描かれる。 */
  await expect.poll(() => tilePixelSum(page, 0), { timeout: 5000 }).toBeGreaterThan(0);

  /* スクロールで入ってきたタイルも描かれる。 */
  await page.getByTestId("reel").evaluate((el) => {
    el.scrollLeft = 40000;
  });
  const mid = Math.floor(40100 / 8192);
  await expect.poll(() => tilePixelSum(page, mid), { timeout: 5000 }).toBeGreaterThan(0);
});

/* テーマ切り替えでルーラーの目盛り色が旧テーマのまま残る回帰。 */
test("テーマを切り替えるとルーラーが描き直される", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const tile = page.locator("[data-testid=ruler] canvas").first();
  const shot = () => tile.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  /* 初回描画（未描画タイルは width=0 で "data:," になる）を待つ。 */
  await expect.poll(shot, { timeout: 5000 }).not.toBe("data:,");
  const dark = await shot();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(shot, { timeout: 5000 }).not.toBe(dark);
});
