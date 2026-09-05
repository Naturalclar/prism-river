import type { Page } from "@playwright/test";
import { expect, load, makeTone, test, wavWindowHz } from "./helpers";

/**
 * タイムストレッチ / ピッチシフト（#25）。Rubber Band（WASM）をオフラインで
 * 掛ける。見るのは「速さだけ変わって高さは変わらない」——`playbackRate` と
 * 何が違うのかがここにしか出ないので、書き出した WAV の周波数まで見る。
 */

/** TS パネルを開く。 */
async function openPanel(page: Page, name: string) {
  await page.getByRole("button", { name: `${name} のストレッチ`, exact: true }).click();
  await expect(page.getByTestId("stretchpanel")).toBeVisible();
}

/** 書き出した WAV を受け取る。 */
async function exportWav(page: Page): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 30_000 });
  const p = await (await download).path();
  if (!p) throw new Error("download path unavailable");
  return p;
}

test("0.5倍速にすると尺が2倍になり、計測値が出る", async ({ page }) => {
  await load(page, [makeTone("slow.wav", 440, 2)]);
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  await openPanel(page, "slow");

  await page.getByTestId("stretch-tempo-0.5").click();
  await expect(page.getByTestId("log")).toContainText("テンポ 0.5x", { timeout: 30_000 });
  /* 尺が2倍になる（クリップも時計もここで決まる）。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00", { timeout: 30_000 });
  await expect(page.getByTestId("stretch-tempo-val")).toHaveText("0.50x");

  /* #25 の確認方法どおり、処理時間をテレメトリに出す。 */
  await expect(page.getByTestId("probe-stretch")).toContainText("ms");
  await expect(page.getByTestId("probe-stretch")).toContainText("倍速");
});

/* 本命: ピッチが変わらないこと。playbackRate では絶対に通らない。 */
test("テンポを落としてもピッチは変わらない", async ({ page }) => {
  await load(page, [makeTone("pitch.wav", 440, 3)]);
  await openPanel(page, "pitch");

  /* まず素のままの周波数を測る（測り方の較正も兼ねる）。 */
  const before = wavWindowHz(await exportWav(page), 0.5, 1.5);
  expect(before).toBeGreaterThan(430);
  expect(before).toBeLessThan(450);

  await page.getByTestId("stretch-tempo-0.5").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:06.00", { timeout: 30_000 });

  const after = wavWindowHz(await exportWav(page), 1, 2);
  expect(after).toBeGreaterThan(430);
  expect(after).toBeLessThan(450);
});

test("ピッチだけ +12半音 上げると尺は変わらず高さが倍になる", async ({ page }) => {
  await load(page, [makeTone("up.wav", 220, 3)]);
  await openPanel(page, "up");

  await page.getByTestId("stretch-pitch").evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, "12");
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByTestId("log")).toContainText("ピッチ +12半音", { timeout: 30_000 });
  await expect(page.getByTestId("stretch-pitch-val")).toHaveText("+12 半音");
  /* 尺は動かない。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");

  const hz = wavWindowHz(await exportWav(page), 0.5, 1.5);
  expect(hz).toBeGreaterThan(420);
  expect(hz).toBeLessThan(460);
});

test("等倍に戻すと元の尺と音に戻る（掛け直しは元の音から）", async ({ page }) => {
  await load(page, [makeTone("back.wav", 440, 2)]);
  await openPanel(page, "back");

  await page.getByTestId("stretch-tempo-0.5").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00", { timeout: 30_000 });
  /* 0.5倍 → 2倍 と続けて掛けても、掛け合わせ（0.25倍速・8秒）にはならない。 */
  await page.getByTestId("stretch-tempo-1.5").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:01.33", { timeout: 30_000 });

  await page.getByTestId("stretch-reset").click();
  await expect(page.getByTestId("log")).toContainText("等倍に戻しました", { timeout: 30_000 });
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
});

test("トリムした位置はストレッチしても比例して残る", async ({ page }) => {
  await load(page, [makeTone("trimmed.wav", 440, 4)]);

  /* 右端を 140px（＝2秒ぶん）縮めて、実効長を 2秒 にする。 */
  const box = await page.getByTestId("clip").boundingBox();
  if (!box) throw new Error("clip not found");
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 4, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4 - 140, cy, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");

  await openPanel(page, "trimmed");
  await page.getByTestId("stretch-tempo-0.5").click();
  /* 素材が 8秒 になり、トリムも比例して伸びるので実効長は 4秒。
     比例させないと「素材の真ん中で切れる」ようになる。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00", { timeout: 30_000 });
});

test("保存 → リロード → 復元でストレッチが戻る", async ({ page }) => {
  await load(page, [makeTone("keepts.wav", 440, 2)]);
  await openPanel(page, "keepts");
  await page.getByTestId("stretch-tempo-0.5").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00", { timeout: 30_000 });

  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  await page.reload();
  /* リロードすると自動で戻る（#80）。ストレッチの掛け直しを含むので待ちは長めに。 */
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 30_000 });
  /* 尺が戻っている＝復元でもストレッチが掛け直されている。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00", { timeout: 30_000 });

  await openPanel(page, "keepts");
  await expect(page.getByTestId("stretch-tempo-val")).toHaveText("0.50x");
});
