import { readFileSync } from "node:fs";
import { encodeWavBytes } from "../src/lib/wav";
import { captureSpeakers, capturedSamples, expect, load, makeTone, savedProject, setRange, test, wavWindowPeak } from "./helpers";

/** トラックエフェクト（EQ / コンプ）。 */

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

test("FX を開いたまま選択を変えると、パネルもそのトラックに切り替わる（#79）", async ({ page }) => {
  await load(page, [makeTone("a.wav", 150, 1), makeTone("b.wav", 300, 1)]);
  const heads = page.getByTestId("track-head");
  const title = page.getByTestId("fxpanel").locator(".fx-top b").first();

  /* 1本目の FX を開くと、そのトラックが選択になる。 */
  await heads.nth(0).getByRole("button", { name: /のエフェクト$/ }).click();
  await expect(title).toHaveText("a");
  await expect(heads.nth(0)).toHaveClass(/selected/);
  await setRange(page, "[data-testid=fx-low]", -12);
  await expect(page.getByTestId("fxpanel")).toContainText("-12 dB");

  /* ラックで2本目を選ぶと、パネルは2本目（EQ は素のまま）になる。 */
  await heads.nth(1).locator(".head-name").click();
  await expect(title).toHaveText("b");
  await expect(page.getByTestId("fx-low")).toHaveValue("0");

  /* 戻すと、さっき下げた LOW が残っている。 */
  await heads.nth(0).locator(".head-name").click();
  await expect(title).toHaveText("a");
  await expect(page.getByTestId("fx-low")).toHaveValue("-12");
});

test("roomの末尾、バス、再読み込み後のPCMが一致する", async ({ page }) => {
  await captureSpeakers(page);
  const sr = 44100;
  const impulse = new Float32Array(sr);
  impulse[sr - Math.round(0.008 * sr)] = 0.9;
  const bytes = encodeWavBytes({ sampleRate: sr, length: sr, numberOfChannels: 1, getChannelData: () => impulse });
  await page.getByTestId("picker").setInputFiles({ name: "pulse.wav", mimeType: "audio/wav", buffer: Buffer.from(bytes) });
  const fx = page.getByRole("button", { name: /のエフェクト$/ });
  await fx.click();
  const mix = async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
    return (await (await download).path())!;
  };
  expect(wavWindowPeak(await mix(), 1, 1.1)).toBe(0);
  await page.getByTestId("bus-strings").click();
  await setRange(page, "[data-testid=fx-room]", 1);
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("再生を終了");
  // Allow the live tail and the audio callback to drain after transport reaches the end.
  await page.waitForTimeout(350);
  const live = await capturedSamples(page);
  const onset = live.findIndex((sample) => Math.abs(sample) > 0.1);
  expect(onset).toBeGreaterThan(0);
  // The fixture contains exactly one dry impulse. Secondary arrivals must be room output.
  expect(live.slice(onset + 300, onset + 3500).some((sample) => Math.abs(sample) > 0.03)).toBe(true);
  const wet = await mix();
  expect(wavWindowPeak(wet, 1.01, 1.05)).toBeGreaterThan(1000);
  expect(wavWindowPeak(wet, 1.11, 1.2)).toBeGreaterThan(1);
  await setRange(page, "#busvol-strings", 0);
  expect(wavWindowPeak(await mix(), 0, 1.5)).toBe(0);
  await setRange(page, "#busvol-strings", 1);
  await expect.poll(async () => (await savedProject(page))?.tracks[0]?.fx.room).toBe(1);
  await page.reload();
  await fx.click();
  await expect(page.getByTestId("fx-room")).toHaveValue("1");
  expect(readFileSync(await mix()).equals(readFileSync(wet))).toBe(true);
});
