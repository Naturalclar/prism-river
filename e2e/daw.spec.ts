import { expect, test, type Page } from "@playwright/test";
import { makeTone } from "./fixture";

/** 読み込み〜再生〜書き出しまで、v0 で実機確認したのと同じ道筋を通す。 */

async function load(page: Page, files: string[]) {
  await page.setInputFiles("[data-testid=picker]", files);
  await expect(page.getByTestId("track-head")).toHaveCount(files.length);
}

/* range 入力は fill が効かないので、ネイティブの setter で値を入れて input を飛ばす。 */
async function setZoom(page: Page, value: number) {
  await page.locator("#zoom").evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/* タイル canvas の中央行を読んで、描画済みかどうかを見る。未描画（width=0）は 0。 */
async function tilePixelSum(page: Page, index: number): Promise<number> {
  return page
    .locator("[data-testid=clip] canvas")
    .nth(index)
    .evaluate((el) => {
      const cv = el as HTMLCanvasElement;
      if (!cv.width) return 0;
      const g = cv.getContext("2d");
      if (!g) return 0;
      const d = g.getImageData(0, Math.floor(cv.height / 2), Math.min(2000, cv.width), 1).data;
      let s = 0;
      for (const v of d) s += v;
      return s;
    });
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

/* 全幅 1 枚の canvas は一辺上限（Chromium 65535 デバイス px）を超えると
   黙って白紙になる回帰。170秒 × 400px/s = 68,000px で上限を踏む。 */
test("長尺トラックを高ズームにしても波形が消えない", async ({ page }) => {
  await load(page, [makeTone("long.wav", 440, 170)]);
  await setZoom(page, 400);

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

test("トラックを消すと空の案内に戻る", async ({ page }) => {
  await load(page, [makeTone("gone.wav", 440)]);
  await page.getByRole("button", { name: /削除/ }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
});
