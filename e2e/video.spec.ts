import { expect, test, wavWindowPeak } from "./helpers";

/**
 * #31 段1: 動画コンテナの取り込み。テスト内で音声つき webm をその場生成して
 * ドロップする（権利のあるファイルをリポジトリに置かない方針のまま）。
 * mp4(H.264+AAC) は Playwright の Chromium にプロプライエタリコーデックが
 * 無くここでは測れないので、実機での確認は #22 に合わせる。
 */

test("音声つき動画（webm）をドロップすると音声トラックになる", async ({ page }) => {
  await page.evaluate(async () => {
    /* canvas の映像トラック + オシレータの音声トラックで動画を作る。 */
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 64;
    const g = cv.getContext("2d");
    if (!g) throw new Error("canvas 2d unavailable");
    const paint = setInterval(() => {
      g.fillStyle = `hsl(${(Date.now() / 4) % 360}, 60%, 50%)`;
      g.fillRect(0, 0, 64, 64);
    }, 50);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const stream = new MediaStream([
      ...cv.captureStream(10).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    rec.addEventListener("dataavailable", (e) => chunks.push(e.data));
    const stopped = new Promise((r) => rec.addEventListener("stop", r, { once: true }));
    rec.start();
    await new Promise((r) => setTimeout(r, 700));
    rec.stop();
    await stopped;
    clearInterval(paint);
    osc.stop();
    void ac.close();

    const dt = new DataTransfer();
    dt.items.add(new File(chunks, "movie.webm", { type: "video/webm" }));
    const stage = document.querySelector(".stage");
    if (!stage) throw new Error("stage not found");
    stage.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });

  /* 音声だけのトラックが1本増え、動画由来だと分かるログが出る。 */
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toContainText("movie");
  await expect(page.getByTestId("log")).toContainText("動画から音声のみ取り込み");
  await expect(page.getByTestId("clip")).toHaveCount(1);

  /* 取り込んだ音声はそのまま書き出しにも乗る。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");
  /* 440Hz のトーンが実際に入っている（無音の動画ではない）。 */
  expect(wavWindowPeak(file, 0.1, 0.5)).toBeGreaterThan(3000);
});

test("音声を取り出せない動画は動画由来だと分かるメッセージが出る", async ({ page }) => {
  await page.evaluate(() => {
    /* 中身がでたらめな mp4。decodeAudioData は必ず失敗する。 */
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(64)], "broken.mp4", { type: "video/mp4" }));
    const stage = document.querySelector(".stage");
    if (!stage) throw new Error("stage not found");
    stage.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("log")).toContainText("broken.mp4 から音声を取り出せませんでした");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
});
