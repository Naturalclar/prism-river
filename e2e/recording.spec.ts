import { canvasPixelSum, expect, load, makeTone, test } from "./helpers";

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

/* #64: 曲の途中に重ねて録ったトラックが 0秒 に落ちていた回帰。録音を始めた
   位置に置かれること（クリップの left は offset × pxPerSec）を見る。 */
test("再生に重ねた録音は、録り始めた位置に置かれる", async ({ page }) => {
  await load(page, [makeTone("base.wav", 440, 8)]);
  await page.getByRole("button", { name: "再生", exact: true }).click();
  /* 1.2秒ぶん進めてから録り始める。 */
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: "マイクから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("録音中");
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "録音を停止", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 10_000 });

  const lefts = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=clip]")].map(
      (e) => Number.parseFloat((e as HTMLElement).style.left) || 0,
    ),
  );
  /* 読み込んだ方は 0秒。録音ぶんは 0 より右（既定ズーム 70px/s なので約 84px）。
     CI の実行速度でぶれるので、0.5〜3秒に相当する幅で見る。 */
  expect(lefts[0]).toBe(0);
  expect(lefts[1]).toBeGreaterThan(35);
  expect(lefts[1]).toBeLessThan(210);
  await expect(page.getByTestId("log")).toContainText("位置 ");
});

/* #63: 停止するまで何がどこに録れているのか一切出なかった回帰。**停止する前に**
   タイムライン上へ仮クリップが伸びていることを見る。 */
test("録音中、停止する前からタイムラインに録れている範囲が出る", async ({ page }) => {
  await page.getByRole("button", { name: "マイクから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("録音中");
  await expect(page.getByTestId("rec-clip")).toBeVisible();

  /* 実時間でしか録れないので、伸びるぶんだけ待つ。 */
  await page.waitForTimeout(400);
  const w1 = await page.getByTestId("rec-clip").evaluate((e) => (e as HTMLElement).offsetWidth);
  await page.waitForTimeout(400);
  const w2 = await page.getByTestId("rec-clip").evaluate((e) => (e as HTMLElement).offsetWidth);
  /* 録れているぶんだけ右へ伸びる（既定ズーム 70px/s なので 400ms で約 28px）。 */
  expect(w1).toBeGreaterThan(10);
  expect(w2).toBeGreaterThan(w1);

  /* 中央行に描画があり、そこから外れた行にも届いている＝振幅のある帯になっている
     （フェイクマイクはトーンを流すので、無音の1px線では終わらない）。 */
  expect(await canvasPixelSum(page, "[data-testid=rec-canvas]")).toBeGreaterThan(0);
  expect(await canvasPixelSum(page, "[data-testid=rec-canvas]", 0.3)).toBeGreaterThan(0);

  /* 停止したら本物のクリップに差し替わる。仮のものが残って二重にならない。 */
  await page.getByRole("button", { name: "録音を停止", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("clip")).toHaveCount(1);
  await expect(page.getByTestId("rec-clip")).toHaveCount(0);
});

/* 仮クリップと本物が同じ位置に出ること（#63 と #64 の噛み合わせ）。ここがずれると
   「描いていた所と違う場所にクリップが落ちる」形で目に見える。 */
test("再生に重ねると、仮クリップは録り始めた位置から伸びる", async ({ page }) => {
  await load(page, [makeTone("base.wav", 440, 8)]);
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: "マイクから録音", exact: true }).click();
  await expect(page.getByTestId("rec-clip")).toBeVisible();
  await page.waitForTimeout(500);
  const ghostLeft = await page
    .getByTestId("rec-clip")
    .evaluate((e) => Number.parseFloat((e as HTMLElement).style.left) || 0);
  expect(ghostLeft).toBeGreaterThan(35);

  await page.getByRole("button", { name: "録音を停止", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 10_000 });

  const realLeft = await page.evaluate(
    () =>
      Number.parseFloat(
        (document.querySelectorAll("[data-testid=clip]")[1] as HTMLElement).style.left,
      ) || 0,
  );
  /* 同じ位置。丸めのぶんだけ許す。 */
  expect(Math.abs(realLeft - ghostLeft)).toBeLessThan(2);
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
  /* 録音が始まっていないので、仮クリップ（#63）も出ない。 */
  await expect(page.getByTestId("rec-clip")).toHaveCount(0);
  /* afterEach の「ページ例外ゼロ」も検証対象: reject を握り損ねると
     unhandled rejection がここで出る。 */
});
