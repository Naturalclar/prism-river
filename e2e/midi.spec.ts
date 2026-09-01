import { expect, load, test, wavWindowPeak } from "./helpers";
import { makeMidi, makeUnsupportedMidi } from "./fixture";

/**
 * #46: MIDI（.mid）を読み込んで内蔵シンセで鳴らす。
 * 「取り込めた」だけでなく、書き出した WAV の中身で**実際に音が出ている**ことを見る。
 */

test("MIDI を読み込むとトラックになり、書き出した音にノートが出る", async ({ page }) => {
  /* 120BPM / 480tpqn なので 1拍 = 0.5秒。0.0〜1.0s と 2.0〜3.0s に音、間は無音。 */
  const file = makeMidi("tune.mid", [
    { atBeat: 0, beats: 2, midi: 60 },
    { atBeat: 4, beats: 2, midi: 67 },
  ]);
  await load(page, [file]);

  await expect(page.getByTestId("track-head")).toContainText("tune");
  await expect(page.getByTestId("log")).toContainText("MIDI 2音");
  await expect(page.getByTestId("probe-midi")).toContainText("音");
  /* 全長は最後のノートの終わり（3.0秒）。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 20_000 });
  const path = await (await download).path();
  if (!path) throw new Error("download path unavailable");

  /* 音のある区間にはピークが立ち、間の無音区間は静か。 */
  const first = wavWindowPeak(path, 0.1, 0.9);
  const gap = wavWindowPeak(path, 1.2, 1.9);
  const second = wavWindowPeak(path, 2.1, 2.9);
  expect(first).toBeGreaterThan(3000);
  expect(second).toBeGreaterThan(3000);
  expect(gap).toBeLessThan(first * 0.1);
});

test("複数チャンネルの MIDI はチャンネルごとにトラックが分かれる", async ({ page }) => {
  const file = makeMidi(
    "band.mid",
    [
      { atBeat: 0, beats: 2, midi: 60, channel: 0 },
      { atBeat: 0, beats: 2, midi: 67, channel: 1 },
      /* チャンネル10（0 始まりで 9）はドラム。段1では鳴らさず、その旨を伝える。 */
      { atBeat: 0, beats: 1, midi: 36, channel: 9 },
    ],
    1,
  );
  await page.setInputFiles("[data-testid=picker]", file);
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  await expect(page.getByTestId("track-head").first()).toContainText("ch1");
  await expect(page.getByTestId("track-head").nth(1)).toContainText("ch2");
  await expect(page.getByTestId("log")).toContainText("ドラム 1音");
});

test("保存 → リロード → 復元で MIDI 由来トラックが戻る", async ({ page }) => {
  const file = makeMidi("keep.mid", [
    { atBeat: 0, beats: 2, midi: 60, channel: 0 },
    { atBeat: 0, beats: 2, midi: 64, channel: 1 },
  ], 1);
  await page.setInputFiles("[data-testid=picker]", file);
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  await page.reload();
  await page.getByRole("button", { name: "前回を復元", exact: true }).click();
  /* 復元でも decodeAudioData に流さず MIDI 経路を通ること（通らないと 0 本になる）。 */
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  await expect(page.getByTestId("track-head").first()).toContainText("keep");
  await expect(page.locator(".clock i")).toHaveText("/ 00:01.00");

  /* 復元後も書き出しが通り、音が入っている。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 20_000 });
  const path = await (await download).path();
  if (!path) throw new Error("download path unavailable");
  expect(wavWindowPeak(path, 0.1, 0.9)).toBeGreaterThan(3000);
});

test("読めない MIDI は理由が分かる文言で伝える", async ({ page }) => {
  await page.setInputFiles("[data-testid=picker]", makeUnsupportedMidi("weird.mid"));
  /* 「ブラウザが対応していない」ではなく、format 2 だからと伝わること。 */
  await expect(page.getByTestId("log")).toContainText("format 2");
  await expect(page.getByTestId("log")).not.toContainText("ブラウザが対応していません");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
});
