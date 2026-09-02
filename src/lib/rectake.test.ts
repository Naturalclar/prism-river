import { describe, expect, it } from "vitest";
import { TAKE_SLICE, emptyTake, growTake, peakOfBytes, takeAmpAt } from "./rectake";

describe("emptyTake", () => {
  it("録り始めた位置を持ち、長さは 0 から始まる", () => {
    const t = emptyTake(1.5);
    expect(t.at).toBe(1.5);
    expect(t.dur).toBe(0);
    expect(takeAmpAt(t, 0)).toBe(0);
  });
});

describe("growTake", () => {
  it("経過ぶんだけ伸び、その区間に振幅が入る", () => {
    const t = emptyTake(0);
    growTake(t, 0.1, 0.5);
    expect(t.dur).toBeCloseTo(0.1);
    expect(takeAmpAt(t, 0.05)).toBeCloseTo(0.5);
    /* まだ録れていない先は 0（描かない）。 */
    expect(takeAmpAt(t, 0.2)).toBe(0);
  });

  it("フレームが飛んだ区間も同じ値で埋める（偽の無音を作らない）", () => {
    const t = emptyTake(0);
    growTake(t, TAKE_SLICE, 0.4);
    /* 200ms ぶん一気に飛ぶ＝10列ぶん抜ける。 */
    growTake(t, TAKE_SLICE + 0.2, 0.6);
    for (let sec = 0; sec < t.dur - TAKE_SLICE; sec += TAKE_SLICE) {
      expect(takeAmpAt(t, sec)).toBeGreaterThan(0);
    }
  });

  it("巻き戻りと停滞は無視する", () => {
    const t = emptyTake(0);
    growTake(t, 0.5, 0.3);
    growTake(t, 0.5, 0.9);
    growTake(t, 0.2, 0.9);
    expect(t.dur).toBeCloseTo(0.5);
    /* 進んでいないので書き換わらない。 */
    expect(takeAmpAt(t, 0.4)).toBeCloseTo(0.3);
  });

  it("初期の容量を超えても伸ばせる", () => {
    const t = emptyTake(0);
    /* 既定の確保は 4秒ぶん。 */
    growTake(t, 30, 0.7);
    expect(t.dur).toBe(30);
    expect(takeAmpAt(t, 29.9)).toBeCloseTo(0.7);
  });

  it("同じ列に複数フレームが来たら大きい方を残す", () => {
    const t = emptyTake(0);
    growTake(t, TAKE_SLICE / 3, 0.2);
    growTake(t, (TAKE_SLICE / 3) * 2, 0.8);
    expect(takeAmpAt(t, 0)).toBeCloseTo(0.8);
  });
});

describe("peakOfBytes", () => {
  it("無音（中央値のみ）は 0", () => {
    expect(peakOfBytes(new Uint8Array([128, 128, 128]))).toBe(0);
  });

  it("振れ幅の大きい方を採る（RMS ではなくピーク）", () => {
    /* 1サンプルだけ振れている列。RMS ならほぼ 0 に均されるが、ピークは残る。 */
    const buf = new Uint8Array(64).fill(128);
    buf[7] = 255;
    expect(peakOfBytes(buf)).toBeCloseTo(127 / 128);
  });

  it("下側の振れも同じに数える", () => {
    expect(peakOfBytes(new Uint8Array([128, 0]))).toBe(1);
  });
});
