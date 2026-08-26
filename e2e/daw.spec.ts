import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { makeTone } from "./fixture";

/** 読み込み〜再生〜書き出しまで、v0 で実機確認したのと同じ道筋を通す。 */

async function load(page: Page, files: string[]) {
  await page.setInputFiles("[data-testid=picker]", files);
  await expect(page.getByTestId("track-head")).toHaveCount(files.length);
}

/* range 入力は fill が効かないので、ネイティブの setter で値を入れて input を飛ばす。 */
async function setRange(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/* 書き出された WAV の指定区間のピーク振幅（int16 の絶対値）。 */
function wavWindowPeak(path: string, fromSec: number, toSec: number): number {
  const buf = readFileSync(path);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sr = v.getUint32(24, true);
  const ch = v.getUint16(22, true);
  const n = Math.floor((buf.byteLength - 44) / 2);
  const a = Math.min(n, Math.floor(fromSec * sr) * ch);
  const b = Math.min(n, Math.floor(toSec * sr) * ch);
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(v.getInt16(44 + i * 2, true)));
  return peak;
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

/* #13: グループバス。2トラックを別バスへ割り当て、一方のバス音量を 0 にして
   書き出すと、そのバスのトラックだけがレンダーから消えることを確かめる。 */
test("トラックをバスに割り当てるとバス音量が書き出しに効く", async ({ page }) => {
  /* busA は 2 秒・busB は 1 秒。後半 1 秒は busA しか鳴らない区間になる。 */
  await load(page, [makeTone("busA.wav", 440, 2), makeTone("busB.wav", 330, 1)]);

  /* 割り当て: busA → 弦（ルナサ）、busB → 管（メルラン）。 */
  const headA = page.getByTestId("track-head").nth(0);
  const headB = page.getByTestId("track-head").nth(1);
  await headA.getByTestId("bus-strings").click();
  await expect(headA.getByTestId("bus-strings")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("log")).toContainText("busA → 弦バス（ルナサ）");
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "true");

  /* もう一度押すと外れて Master 直結に戻り、押し直せる（トグル）。 */
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("log")).toContainText("Master 直結");
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "true");

  /* 弦バスのフェーダーを 0 へ。 */
  await setRange(page, "#busvol-strings", 0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  /* 前半: 管バスの busB は生きている。 */
  expect(wavWindowPeak(file, 0.2, 0.45)).toBeGreaterThan(3000);
  /* 後半: busA だけの区間。弦バスが 0 なので無音になる。 */
  expect(wavWindowPeak(file, 1.2, 1.8)).toBeLessThan(200);
});

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

  /* バスの割り当ても保存対象（#13）。 */
  await page.getByTestId("track-head").first().getByTestId("bus-keys").click();

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
  await expect(
    page.getByTestId("track-head").first().getByTestId("bus-keys"),
  ).toHaveAttribute("aria-pressed", "true");
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

test("トラックを消すと空の案内に戻る", async ({ page }) => {
  await load(page, [makeTone("gone.wav", 440)]);
  await page.getByRole("button", { name: /削除/ }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
});

/* #20: MP3（LAME / WASM）のオフライン書き出し。webm と違い実時間はかからない。 */
test("MP3 で書き出すと WASM エンコードの計測値が出る", async ({ page }) => {
  await load(page, [makeTone("mp1.wav", 440, 3), makeTone("mp2.wav", 550, 3)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "MP3 で書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MP3 を書き出しました", { timeout: 20_000 });

  const d = await download;
  expect(d.suggestedFilename()).toBe("prism-river-mix.mp3");
  const file = await d.path();
  if (!file) throw new Error("download path unavailable");
  const bytes = readFileSync(file);

  /* ヘッダ: ID3v2 タグ、または MPEG フレーム同期（0xFF + 上位3bit）。 */
  const sync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  const id3 = bytes.subarray(0, 3).toString() === "ID3";
  expect(sync || id3).toBe(true);

  /* CBR 192kbps の3秒 ≈ 72KB。同じ尺の WAV（≈0.5MB）より桁で小さい。 */
  expect(bytes.length).toBeGreaterThan(40_000);
  expect(bytes.length).toBeLessThan(150_000);

  /* エンコード時間のテレメトリが埋まり、実時間より速い（=1倍超）と表示される。 */
  await expect(page.getByTestId("probe-mp3")).toContainText("ms");
  await expect(page.getByTestId("probe-mp3")).toContainText("倍速");
});
