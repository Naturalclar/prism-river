import { describe, expect, it } from "vitest";
import {
  decodeDrumPattern,
  emptyPattern,
  encodeDrumPattern,
  expandPattern,
  patternDuration,
  presetHits,
  STEPS,
  stepSec,
  type DrumPattern,
} from "./drums";

/** 1音だけ置いたパターン。時刻の検証用。 */
function oneKick(step: number, bpm = 120, bars = 1): DrumPattern {
  const p = emptyPattern(bpm, bars);
  p.hits.kick[step] = true;
  return p;
}

describe("stepSec / patternDuration", () => {
  it("120BPM の16分音符は 0.125 秒", () => {
    expect(stepSec(120)).toBeCloseTo(0.125, 6);
  });

  it("BPM が倍になればステップは半分", () => {
    expect(stepSec(240)).toBeCloseTo(stepSec(120) / 2, 6);
  });

  it("全長は bars 小節 × 4拍", () => {
    /* 120BPM の1小節は 2 秒（4拍 × 0.5s）。 */
    expect(patternDuration(emptyPattern(120, 1))).toBeCloseTo(2, 6);
    expect(patternDuration(emptyPattern(120, 4))).toBeCloseTo(8, 6);
    expect(patternDuration(emptyPattern(60, 2))).toBeCloseTo(8, 6);
  });

  it("BPM と小節数は範囲外でも壊れない（クランプする）", () => {
    expect(stepSec(0)).toBeCloseTo(stepSec(40), 6);
    expect(patternDuration({ ...emptyPattern(120, 99) })).toBeCloseTo(
      patternDuration(emptyPattern(120, 4)),
      6,
    );
  });
});

describe("expandPattern", () => {
  it("置いた位置がステップ番号 × ステップ長になる", () => {
    expect(expandPattern(oneKick(0))).toEqual([{ voice: "kick", atSec: 0 }]);
    expect(expandPattern(oneKick(4))[0].atSec).toBeCloseTo(0.5, 6);
    expect(expandPattern(oneKick(15))[0].atSec).toBeCloseTo(1.875, 6);
  });

  it("小節ぶん繰り返し、2周目は1小節ぶんずれる", () => {
    const hits = expandPattern(oneKick(0, 120, 3));
    expect(hits).toHaveLength(3);
    expect(hits[1].atSec).toBeCloseTo(2, 6);
    expect(hits[2].atSec).toBeCloseTo(4, 6);
  });

  it("繰り返しても最後の音は全長より前にある", () => {
    const p = oneKick(STEPS - 1, 120, 2);
    const last = expandPattern(p).at(-1);
    expect(last?.atSec).toBeLessThan(patternDuration(p));
  });

  it("同じステップに複数の音色が乗る", () => {
    const p = emptyPattern(120, 1);
    p.hits.kick[0] = true;
    p.hits.hatClosed[0] = true;
    const hits = expandPattern(p);
    expect(new Set(hits.map((h) => h.voice))).toEqual(new Set(["kick", "hatClosed"]));
    expect(hits.every((h) => h.atSec === 0)).toBe(true);
  });

  it("空のパターンは1発も鳴らない", () => {
    expect(expandPattern(emptyPattern())).toEqual([]);
  });
});

describe("presetHits", () => {
  it("どのプリセットも 16 ステップぶんの行を持つ", () => {
    for (const id of ["four", "eight", "shuffle", "empty"] as const) {
      const hits = presetHits(id);
      for (const row of Object.values(hits)) expect(row).toHaveLength(STEPS);
    }
  });

  it("四つ打ちはキックが4拍（0/4/8/12）に来る", () => {
    const kick = presetHits("four").kick;
    expect(kick.flatMap((on, i) => (on ? [i] : []))).toEqual([0, 4, 8, 12]);
  });

  it("クリアは全部 false", () => {
    expect(Object.values(presetHits("empty")).flat().some(Boolean)).toBe(false);
  });
});

describe("decodeDrumPattern", () => {
  it("書いたものを読み戻せる", () => {
    const p = oneKick(3, 90, 2);
    expect(decodeDrumPattern(encodeDrumPattern(p))).toEqual(p);
  });

  it("壊れた JSON・型違い・行の長さ違いは null", () => {
    expect(decodeDrumPattern("{")).toBeNull();
    expect(decodeDrumPattern("null")).toBeNull();
    expect(decodeDrumPattern(JSON.stringify({ bpm: 120, bars: 1 }))).toBeNull();
    const short = emptyPattern() as unknown as { hits: Record<string, boolean[]> };
    short.hits.kick = [true, false];
    expect(decodeDrumPattern(JSON.stringify(short))).toBeNull();
  });

  it("範囲外の BPM / 小節数はクランプして読む（保存を壊さない）", () => {
    const wild = { ...emptyPattern(), bpm: 9999, bars: 42 };
    const got = decodeDrumPattern(JSON.stringify(wild));
    expect(got?.bpm).toBe(240);
    expect(got?.bars).toBe(4);
  });
});
