import { expect, load, makeTone, setRange, test, wavWindowPeak } from "./helpers";

/** トラックエフェクト（EQ / コンプ）。 */

/* EQ が書き出しの信号経路に入っている回帰。200Hz の低棚を -12dB にして、
   その下の 150Hz トーンが素の書き出しより小さくなることで確かめる。 */
test("EQ の低シェルフが書き出しに効く", async ({ page }) => {
  await load(page, [makeTone("eq.wav", 150, 2)]);

  const d1 = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const plain = await (await d1).path();
  if (!plain) throw new Error("download path unavailable");

  await page.getByRole("button", { name: /のエフェクト$/ }).click();
  await expect(page.getByTestId("fxpanel")).toBeVisible();
  await setRange(page, "[data-testid=fx-low]", -12);
  await expect(page.getByTestId("fxpanel")).toContainText("-12 dB");

  const d2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const cut = await (await d2).path();
  if (!cut) throw new Error("download path unavailable");

  const before = wavWindowPeak(plain, 0.4, 0.7);
  const after = wavWindowPeak(cut, 0.4, 0.7);
  expect(before).toBeGreaterThan(3000);
  expect(after).toBeLessThan(before * 0.6);
});
