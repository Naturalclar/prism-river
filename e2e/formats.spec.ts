import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { expect, load, makeTone, test } from "./helpers";
import { FIXTURE_DIR, makeGarbage, makeToneMp3, makeToneOgg } from "./fixture";

/**
 * #22: decodeAudioData の対応形式。テスト時にその場生成できる形式を Chromium で
 * 実測する。m4a / flac は権利フリーの生成手段がここに無いので、実機と手持ち音源で
 * 埋める（README の対応表参照）。
 */

test("mp3 / ogg (Vorbis) も読み込める", async ({ page }) => {
  await load(page, [await makeToneMp3("fmt-a.mp3", 440), await makeToneOgg("fmt-b.ogg", 330)]);
  await expect(page.getByTestId("probe-trk")).toHaveText("2");
  await expect(page.getByTestId("probe-dec")).toContainText("ms");
});

test("自前で書き出した webm（Opus）を読み戻せる", async ({ page }) => {
  await load(page, [makeTone("rt.wav", 440)]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "webm で書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("webm を書き出しました", { timeout: 30_000 });
  const p = await (await download).path();
  if (!p) throw new Error("download path unavailable");
  /* path() は拡張子なしの一時ファイルなので .webm を付け直す（入口の篩が拡張子を見る）。 */
  const dst = join(FIXTURE_DIR, "roundtrip.webm");
  copyFileSync(p, dst);
  await page.setInputFiles("[data-testid=picker]", dst);
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  await expect(page.getByTestId("track-head").nth(1)).toContainText("roundtrip");
});

test("対応外・壊れたファイルは名前を挙げて伝える", async ({ page }) => {
  /* 壊れた flac → decodeAudioData が拒否し、ファイル名つきで伝わる。 */
  await page.setInputFiles("[data-testid=picker]", makeGarbage("broken.flac"));
  await expect(page.getByTestId("log")).toContainText("broken.flac をデコードできませんでした");
  await expect(page.getByTestId("track-head")).toHaveCount(0);

  /* 対応外の拡張子だけ → 黙って無視せず名前を挙げる。 */
  await page.setInputFiles("[data-testid=picker]", makeGarbage("notes.txt"));
  await expect(page.getByTestId("log")).toContainText("対応外のファイルのみでした: notes.txt");
  await expect(page.getByTestId("track-head")).toHaveCount(0);

  /* 読めるものと混ざっている場合も、スキップした名前が最後に出る。 */
  await page.setInputFiles("[data-testid=picker]", [makeTone("ok.wav", 440), makeGarbage("memo.txt")]);
  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("log")).toContainText("1件を対応外としてスキップ: memo.txt");
});
