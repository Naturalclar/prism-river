import { readFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";

export { makeTone } from "./fixture";
export { expect };

/**
 * 全 spec 共通の土台。トップページを開いてから本体を実行し、
 * どのテストでもページ例外ゼロを要求する（旧 daw.spec.ts の
 * beforeEach / afterEach と同じ不変条件）。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await use(page);
    expect(errors).toEqual([]);
  },
});

export async function load(page: Page, files: string[]) {
  await page.setInputFiles("[data-testid=picker]", files);
  await expect(page.getByTestId("track-head")).toHaveCount(files.length);
}

/* range 入力は fill が効かないので、ネイティブの setter で値を入れて input を飛ばす。 */
export async function setRange(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/* 書き出された WAV の指定区間のピーク振幅（int16 の絶対値）。 */
export function wavWindowPeak(path: string, fromSec: number, toSec: number): number {
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
export async function tilePixelSum(page: Page, index: number): Promise<number> {
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
