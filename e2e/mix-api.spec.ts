import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, load, makeTone, savedProject, setRange, test } from "./helpers";

test("ブラウザAPIから2案を試聴し、採用・Undo・旧案の拒否を確認する", async ({ page }) => {
  await load(page, [makeTone("vocal.wav", 330, 3), makeTone("backing.wav", 550, 3)]);
  const missing = await page.evaluate(async () => {
    const api = window.prismRiver;
    try { await api.preview({ revision: api.inspect().revision, changes: [] }); }
    catch (e) { return (e as { code: string }).code; }
  });
  expect(missing).toBe("missing_range");
  const ruler = await page.getByTestId("ruler").boundingBox();
  if (!ruler) throw new Error("ruler not found");
  await page.mouse.move(ruler.x + 35, ruler.y + 8);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 105, ruler.y + 8, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await savedProject(page))?.loop?.end).toBe(1.5);
  const base = await savedProject(page);
  const original = await page.evaluate(() => window.prismRiver.inspect());
  expect(original.timeUnit).toBe("seconds");
  const target = original.tracks.find(t => t.name === "vocal")!;
  const plans = await page.evaluate(async ({ revision, id }) => {
    const api = window.prismRiver;
    const dry = await api.preview({ revision, changes: [{ trackId: id, gainDbDelta: 2 }] });
    const wet = await api.preview({ revision, changes: [{ trackId: id, gainDbDelta: 2, room: 0.35 }] });
    await api.listen(dry, "A"); await api.listen(dry, "B"); api.stop();
    await api.listen(wet, "B"); api.stop();
    const a = new Int16Array(await api.wav(wet, "A").arrayBuffer(), 44);
    const b = new Int16Array(await api.wav(wet, "B").arrayBuffer(), 44);
    const hash = await crypto.subtle.digest("SHA-256", b.buffer);
    const digest = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
    api.discard(dry);
    return { wet, digest, frames: a.length / 2, different: b.some((v, i) => Math.abs(v - a[i]) > 4) };
  }, { revision: original.revision, id: target.id });
  expect(plans.frames).toBeGreaterThan(40000);
  expect(plans.different).toBe(true);
  await page.waitForTimeout(1500);
  expect(await savedProject(page)).toEqual(base);
  const errors = await page.evaluate(async ({ revision, id }) => {
    const api = window.prismRiver;
    return Promise.all([
      { changes: [{ trackId: "missing", room: 0.1 }] },
      { changes: [{ trackId: id, room: NaN }] },
      { changes: [{ trackId: id, gainDbDelta: 40 }] },
      { changes: [{ trackId: id, room: 0.2 }], range: { start: -1, end: 1 } },
    ].map(async request => {
      try { await api.preview({ revision, ...request }); }
      catch (e) { return (e as { code: string }).code; }
    }));
  }, { revision: original.revision, id: target.id });
  expect(errors).toEqual(["unknown_track", "invalid_value", "invalid_value", "invalid_range"]);
  await page.evaluate(ref => window.prismRiver.apply(ref), plans.wet);
  const applied = await page.evaluate(() => window.prismRiver.inspect());
  expect(applied.revision).toBe(original.revision + 1);
  expect(applied.tracks[0].gain).toBeCloseTo(target.gain * 10 ** 0.1);
  expect(applied.tracks[0].room).toBe(0.35);
  expect(applied.tracks[1]).toEqual(original.tracks[1]);
  await expect.poll(async () => (await savedProject(page))?.tracks[0].fx.room).toBe(0.35);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /選択範囲をWAV/ }).click();
  const file = await (await download).path();
  expect(createHash("sha256").update(readFileSync(file!)).digest("hex")).toBe(plans.digest);
  await page.evaluate(() => window.prismRiver.undo());
  expect((await page.evaluate(() => window.prismRiver.inspect())).tracks).toEqual(original.tracks);
  await setRange(page, "#mVol", 0.42);
  const stale = await page.evaluate(ref => {
    try { window.prismRiver.apply(ref); } catch (e) { return (e as { code: string }).code; }
  }, plans.wet);
  expect(stale).toBe("stale_revision");
  await expect.poll(async () => (await savedProject(page))?.masterVol).toBe(0.42);
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  expect((await page.evaluate(() => window.prismRiver.inspect())).tracks).toEqual(original.tracks);
});
