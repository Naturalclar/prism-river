import { expect, test, wavWindowPeak } from "./helpers";

/**
 * アプリ内で作るドラムループ（#54）。読み込むファイルが1つも無くても
 * トラックが立つのがこの機能の要点なので、どのテストも手ぶらで始める。
 */

/** 格子を空にしてから、指定の位置だけ置く。 */
async function onlyKickAt(page: import("@playwright/test").Page, step: number) {
  await page.getByTestId("drum-preset-empty").click();
  await page.getByTestId(`drum-kick-${step}`).click();
  await expect(page.getByTestId(`drum-kick-${step}`)).toHaveAttribute("aria-pressed", "true");
}

test("ドラムを追加するとトラックが1本増え、格子が開く", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();

  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("drumpanel")).toBeVisible();
  /* 既定は四つ打ち＝キックが 0/4/8/12。空の格子から始めさせない。 */
  for (const i of [0, 4, 8, 12]) {
    /* 4つの assert を並べるだけなので、順に待って構わない。 */
    // oxlint-disable-next-line no-await-in-loop
    await expect(page.getByTestId(`drum-kick-${i}`)).toHaveAttribute("aria-pressed", "true");
  }
  /* 120BPM の2小節＝4.00 秒。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
});

test("置いたステップだけが鳴る（書き出した WAV で確認）", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();
  /* 先頭にキック1発だけ。120BPM なので 1ステップ = 0.125s。 */
  await onlyKickAt(page, 0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  /* 頭で鳴り、置いていない区間は静か。キックの減衰は 0.3s なので 0.5s 以降を見る。 */
  const hit = wavWindowPeak(file, 0, 0.1);
  const gap = wavWindowPeak(file, 0.6, 1.4);
  expect(hit).toBeGreaterThan(3000);
  expect(gap).toBeLessThan(hit / 10);
});

test("ステップを動かすと書き出しの中身も変わる", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();
  await onlyKickAt(page, 0);
  /* 頭を外して 8ステップ目（1拍め裏の裏＝1.0s）へ移す。 */
  await page.getByTestId("drum-kick-0").click();
  await page.getByTestId("drum-kick-8").click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  const head = wavWindowPeak(file, 0, 0.1);
  const moved = wavWindowPeak(file, 1.0, 1.1);
  expect(moved).toBeGreaterThan(3000);
  expect(head).toBeLessThan(moved / 10);
});

test("BPM を変えるとクリップの長さが変わる", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");

  /* 60BPM にすると1小節が倍の 4 秒＝2小節で 8 秒。 */
  await page.locator("[data-testid=drum-bpm]").evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, "60");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".clock i")).toHaveText("/ 00:08.00", { timeout: 10_000 });
});

test("保存してリロードするとパターンごと復元される", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();
  await onlyKickAt(page, 5);

  await page.getByRole("button", { name: "プロジェクトを保存" }).click();
  await expect(page.getByTestId("log")).toContainText("保存しました", { timeout: 15_000 });

  await page.reload();
  await page.getByRole("button", { name: "前回を復元" }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });

  /* 格子を開き直すと、置いた1発だけが残っている（音の正本がパターンなので、
     復元は再レンダーで通っている）。 */
  await page.getByRole("button", { name: /のドラム$/ }).click();
  await expect(page.getByTestId("drum-kick-5")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "false");
});
