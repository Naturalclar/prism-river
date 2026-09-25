import type { Page } from "@playwright/test";
import { expect, load, makeTone, test } from "./helpers";

/** ループする範囲の指定（#88）。ルーラーの横ドラッグで区間を決める。 */

/* 既定ズームは 70px/s。区間の端はクリップの端と 0 秒に吸着するので、
   テストではどのスナップ点からも離れた 1〜3 秒を使う。 */
const PPS = 70;

/** ルーラーを from 秒から to 秒までドラッグする。 */
async function dragRuler(page: Page, from: number, to: number, opts: { shift?: boolean } = {}) {
  const r = await page.getByTestId("ruler").boundingBox();
  if (!r) throw new Error("ruler not found");
  const y = r.y + r.height / 2;
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(r.x + from * PPS, y);
  await page.mouse.down();
  await page.mouse.move(r.x + to * PPS, y, { steps: 8 });
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
}

/** 時計（00:01.23）を秒で読む。 */
async function clockSec(page: Page): Promise<number> {
  const t = (await page.getByTestId("clock-pos").textContent()) ?? "00:00.00";
  const [m, s] = t.split(":");
  return Number(m) * 60 + Number(s);
}

test("ルーラーのドラッグでループ範囲を選べる", async ({ page }) => {
  await load(page, [makeTone("loop.wav", 440, 6)]);
  await expect(page.getByTestId("loop-band")).toBeHidden();

  await dragRuler(page, 1, 3);

  await expect(page.getByTestId("log")).toContainText("ループ範囲: 1.00s – 3.00s");
  const band = await page.getByTestId("loop-band").boundingBox();
  const ruler = await page.getByTestId("ruler").boundingBox();
  if (!band || !ruler) throw new Error("band not found");
  expect(band.x - ruler.x).toBeCloseTo(1 * PPS, 0);
  expect(band.width).toBeCloseTo(2 * PPS, 0);
  /* レーン側にも同じ範囲の網掛けが出る。 */
  await expect(page.getByTestId("loop-zone")).toBeVisible();

  /* 区間を引いたらループは自動で入る（引いた＝繰り返したい、と読む）。 */
  await expect(page.getByRole("button", { name: "ループ", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

/* 本命: 区間の終わりで頭へ戻り、区間の外へは出ない。 */
test("再生は区間の終わりで頭へ戻る", async ({ page }) => {
  await load(page, [makeTone("wrap.wav", 440, 6)]);
  await dragRuler(page, 1, 3);
  await page.getByRole("button", { name: "再生", exact: true }).click();

  /* 5秒ぶんサンプリングする。0秒から始めて 3秒 で折り返すので、
     この間に「3秒 を超えない」「一度は 2.5秒 を過ぎる」「その後 2秒 未満へ戻る」
     が全部観測できる。 */
  const seen: number[] = [];
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    /* 時間軸のサンプリングなので、並列化するとサンプルにならない。 */
    // oxlint-disable-next-line no-await-in-loop
    seen.push(await clockSec(page));
    // oxlint-disable-next-line no-await-in-loop
    await page.waitForTimeout(60);
  }

  /* 区間の終わり（3.00s）を超えて進まない。折り返しの検出は rAF ごとなので、
     1フレームぶんの行き過ぎは許す。 */
  expect(Math.max(...seen)).toBeLessThan(3.2);
  const late = seen.findIndex((v) => v > 2.5);
  expect(late).toBeGreaterThanOrEqual(0);
  /* 折り返し後は区間の頭（1.00s）付近から。0 秒へは戻らない。 */
  const after = seen.slice(late + 1);
  expect(Math.min(...after)).toBeLessThan(2);
  expect(Math.min(...after)).toBeGreaterThan(0.5);
});

test("範囲を解除すると全体を繰り返す（従来どおり）", async ({ page }) => {
  await load(page, [makeTone("clear.wav", 440, 6)]);
  await dragRuler(page, 1, 3);
  await expect(page.getByTestId("loop-zone")).toBeVisible();

  await page.getByTestId("loop-clear").click();
  await expect(page.getByTestId("log")).toContainText("ループ範囲を解除しました");
  await expect(page.getByTestId("loop-band")).toBeHidden();
  await expect(page.getByTestId("loop-zone")).toHaveCount(0);

  /* ループ自体は入ったままなので、全体ループとして 0 秒へ戻る。 */
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect.poll(() => clockSec(page), { timeout: 8000 }).toBeGreaterThan(3.5);
});

test("ルーラーのクリックは今までどおりシークで、区間は作らない", async ({ page }) => {
  await load(page, [makeTone("seek.wav", 440, 6)]);
  const r = await page.getByTestId("ruler").boundingBox();
  if (!r) throw new Error("ruler not found");
  await page.mouse.click(r.x + 2 * PPS, r.y + r.height / 2);

  await expect(page.getByTestId("clock-pos")).toHaveText("00:02.00");
  await expect(page.getByTestId("loop-band")).toBeHidden();
});

test("区間の端は隣のクリップの端に吸着し、Shift で切れる", async ({ page }) => {
  /* 3秒のクリップが1本 → 終端 3.00s がスナップ点。その 4px 手前で離す。 */
  await load(page, [makeTone("snapend.wav", 440, 3)]);
  await dragRuler(page, 1, 3 - 4 / PPS);
  await expect(page.getByTestId("log")).toContainText("ループ範囲: 1.00s – 3.00s");

  await page.getByTestId("loop-clear").click();
  await dragRuler(page, 1, 3 - 4 / PPS, { shift: true });
  await expect(page.getByTestId("log")).toContainText("ループ範囲: 1.00s – 2.94s");
});

test("保存 → リロード → 復元でループ範囲が戻る", async ({ page }) => {
  await load(page, [makeTone("keeploop.wav", 440, 6)]);
  await dragRuler(page, 1, 3);

  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  await page.reload();
  /* リロードすると自動で戻る（#80）。 */
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });

  await expect(page.getByTestId("loop-zone")).toBeVisible();
  const band = await page.getByTestId("loop-band").boundingBox();
  const ruler = await page.getByTestId("ruler").boundingBox();
  if (!band || !ruler) throw new Error("band not found");
  expect(band.x - ruler.x).toBeCloseTo(1 * PPS, 0);
  expect(band.width).toBeCloseTo(2 * PPS, 0);
});
