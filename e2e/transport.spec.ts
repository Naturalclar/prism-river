import { expect, load, makeTone, peakMeter, test } from "./helpers";

/** 読み込み〜再生〜停止〜削除。v0 で実機確認したのと同じ道筋を通す。 */

/* #50: 再生中に足したトラックは停止するまで鳴らなかった（トラックもクリップも
   増え、プレイヘッドはその上を通過するのに無音、という気づけない壊れ方）。
   先に居るトラックをミュートしておき、後から足した側の音だけをメーターで見る。 */
test("再生中に読み込んだトラックもその場から鳴る", async ({ page }) => {
  await load(page, [makeTone("live-a.wav", 440, 6)]);
  await page.getByRole("button", { name: /をミュート/ }).click();
  await page.getByRole("button", { name: "再生", exact: true }).click();

  /* ミュート済みの1本だけなので、この時点では無音。 */
  expect(await peakMeter(page, 600)).toBeLessThan(1);

  await page.setInputFiles("[data-testid=picker]", [makeTone("live-b.wav", 330, 6)]);
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  /* 足した側は再生中のまま鳴り出す（停止して再生し直す必要がない）。 */
  expect(await peakMeter(page, 1500)).toBeGreaterThan(5);
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

test("トラックを消すと空の案内に戻る", async ({ page }) => {
  await load(page, [makeTone("gone.wav", 440)]);
  await page.getByRole("button", { name: /削除/ }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
});
