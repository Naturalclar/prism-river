import { readFileSync } from "node:fs";
import { expect, load, makeTone, savedProject, test, type Page } from "./helpers";

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function project(page: Page) {
  const saved = await savedProject(page);
  if (!saved) throw new Error("project not saved");
  return saved;
}
async function exportMix(page: Page) {
  const download = page.waitForEvent("download");
  await button(page, "ミックスを書き出す").click();
  const path = await (await download).path();
  if (!path) throw new Error("WAV not downloaded");
  return readFileSync(path);
}

// Web Audio の複数入力の加算順で生じる最大1 LSBの端数だけを許容する。
function expectSameAudio(actual: Buffer, expected: Buffer) {
  expect(actual.subarray(0, 44)).toEqual(expected.subarray(0, 44));
  expect(actual.length).toBe(expected.length);
  let difference = 0;
  for (let i = 44; i < actual.length; i += 2) {
    difference = Math.max(difference, Math.abs(actual.readInt16LE(i) - expected.readInt16LE(i)));
  }
  expect(difference).toBeLessThanOrEqual(1);
}

// 3つの周波数を同じ書き出しから検出し、未選択の声と両方の移調量を確認する。
function amplitude(wav: Buffer, hz: number) {
  const rate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  let x = 0;
  let y = 0;
  for (let i = rate; i < rate * 2; i++) {
    const sample = wav.readInt16LE(44 + 2 * channels * i);
    const theta = 2 * Math.PI * hz * i / rate;
    x += sample * Math.cos(theta);
    y += sample * Math.sin(theta);
  }
  return Math.hypot(x, y) / rate;
}

test("2本だけ相対移調し、原曲・候補、Undo、WAV、再読み込みを確認する", async ({ page }) => {
  test.setTimeout(60_000);
  await load(page, [makeTone("bass.wav", 220, 3), makeTone("keys.wav", 440, 3), makeTone("voice.wav", 740, 3)]);
  const clip = await page.getByTestId("clip").first().boundingBox();
  if (!clip) throw new Error("clip missing");
  const y = clip.y + clip.height / 2;
  await page.mouse.move(clip.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(clip.x + 39, y, { steps: 5 });
  await page.mouse.up();
  await button(page, "keys の移調・テンポ").click();
  await page.getByTestId("stretch-tempo-0.75").click();
  await expect(page.getByTestId("stretch-tempo-val")).toHaveText("0.75x");
  await page.getByTestId("stretch-pitch").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("stretch-pitch-val")).toHaveText("+1 半音");
  const ruler = await page.getByTestId("ruler").boundingBox();
  if (!ruler) throw new Error("ruler missing");
  await page.mouse.move(ruler.x + 35, ruler.y + 8);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 140, ruler.y + 8, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedProject(page))?.loop?.end).toBe(2);
  const before = await project(page);
  expect(before.tracks[0].offset).toBeCloseTo(0.5);
  expect(before.tracks[0].trimStart).toBeCloseTo(0.5);
  const originalWav = await exportMix(page);
  await button(page, "まとめて移調").click();
  await page.getByRole("checkbox", { name: "bass" }).check();
  await page.getByRole("checkbox", { name: "keys" }).check();
  await page.getByLabel("半音差").fill("12");
  await button(page, "移調を試聴").click();
  await expect(page.getByRole("status").filter({ hasText: "範囲外" })).toContainText("keys");
  await page.getByLabel("半音差").fill("-3");
  await button(page, "移調を試聴").click();
  await expect(page.getByText("試聴区間 0.50〜2.00 秒")).toBeVisible();
  await button(page, "A 原曲").click();
  await expect(button(page, "A 原曲")).toHaveAttribute("aria-pressed", "true");
  await button(page, "B 移調後").click();
  await expect(button(page, "B 移調後")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1500);
  expect(await project(page)).toEqual(before);
  await page.getByRole("checkbox", { name: "keys" }).uncheck();
  await expect(button(page, "移調を採用")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "keys" }).check();
  await button(page, "移調を試聴").click();
  await button(page, "移調を採用").click();
  await expect.poll(async () => (await project(page)).tracks[0].stretch?.semitones).toBe(-3);
  const expected = structuredClone(before.tracks);
  expected[0].stretch = { tempo: 1, semitones: -3 };
  expected[1].stretch = { tempo: 0.75, semitones: -2 };
  expect((await project(page)).tracks).toEqual(expected);
  await button(page, "直前の採用を元に戻す").click();
  await expect.poll(async () => (await project(page)).tracks).toEqual(before.tracks);
  expectSameAudio(await exportMix(page), originalWav);
  await button(page, "移調を試聴").click();
  await button(page, "移調を採用").click();
  await expect.poll(async () => (await project(page)).tracks).toEqual(expected);
  const audio = await exportMix(page);
  expect(amplitude(audio, 220 * 2 ** (-3 / 12))).toBeGreaterThan(amplitude(audio, 220) * 3);
  expect(amplitude(audio, 440 * 2 ** (-2 / 12))).toBeGreaterThan(amplitude(audio, 440 * 2 ** (1 / 12)) * 3);
  expect(amplitude(audio, 740)).toBeGreaterThan(300);
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(3);
  expectSameAudio(await exportMix(page), audio);
});

test("2本目の計算失敗・計算中のキャンセルで変更を残さない", async ({ page }) => {
  await load(page, [makeTone("bass.wav", 220), makeTone("keys.wav", 440)]);
  await button(page, "bass の移調・テンポ").click();
  await button(page, "まとめて移調").click();
  await page.getByRole("checkbox", { name: "bass" }).check();
  await page.getByRole("checkbox", { name: "keys" }).check();
  await expect.poll(async () => (await savedProject(page))?.tracks.length).toBe(2);
  const before = await project(page);
  const rev = await page.evaluate(() => window.prismRiver.inspect().revision);
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    let count = 0;
    Worker.prototype.postMessage = function(message, transfer) {
      if (message.params && ++count === 2) {
        this.dispatchEvent(new MessageEvent("message", { data: { ok: false, error: "2本目の失敗" } }));
      } else if (count < 3) {
        Reflect.apply(original, this, [message, transfer]);
      }
      // 3回目は計算中のままにしてキャンセルを試す。
    };
  });
  await button(page, "移調を試聴").click();
  await expect(page.getByText("2本目の失敗")).toBeVisible();
  await button(page, "移調を試聴").click();
  await button(page, "キャンセル").click();
  await expect(button(page, "移調を採用")).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await project(page)).toEqual(before);
  expect(await page.evaluate(() => window.prismRiver.inspect().revision)).toBe(rev);
});
