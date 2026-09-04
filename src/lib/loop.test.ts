import { describe, expect, it } from "vitest";
import { clampLoop, loopEnd, loopStart, makeLoop, MIN_LOOP } from "./loop";

describe("makeLoop", () => {
  it("2点から区間を作る", () => {
    expect(makeLoop(1, 3, 10)).toEqual({ start: 1, end: 3 });
  });

  it("右から左へ引いても同じ区間になる", () => {
    expect(makeLoop(3, 1, 10)).toEqual({ start: 1, end: 3 });
  });

  it("0 と全長でクランプする", () => {
    expect(makeLoop(-2, 12, 10)).toEqual({ start: 0, end: 10 });
  });

  it("短すぎる指定（≒クリック）は区間なし", () => {
    expect(makeLoop(1, 1, 10)).toBeNull();
    expect(makeLoop(1, 1 + MIN_LOOP / 2, 10)).toBeNull();
    /* ちょうど MIN_LOOP は成立させる（境界は「使える」側に倒す）。 */
    expect(makeLoop(1, 1 + MIN_LOOP, 10)).toEqual({ start: 1, end: 1 + MIN_LOOP });
  });

  it("全長が 0（トラック無し）なら区間なし", () => {
    expect(makeLoop(0, 5, 0)).toBeNull();
  });

  it("クランプの結果として短くなった場合も区間なし", () => {
    /* 全長 10 の右外だけを指した指定は、クランプすると幅ゼロになる。 */
    expect(makeLoop(11, 12, 10)).toBeNull();
  });
});

describe("clampLoop", () => {
  it("収まっていればそのまま", () => {
    expect(clampLoop({ start: 1, end: 3 }, 10)).toEqual({ start: 1, end: 3 });
  });

  it("曲が短くなったら詰める", () => {
    expect(clampLoop({ start: 1, end: 8 }, 4)).toEqual({ start: 1, end: 4 });
  });

  it("丸ごと外に出たら区間なしにする", () => {
    expect(clampLoop({ start: 6, end: 8 }, 4)).toBeNull();
  });

  it("null はそのまま null", () => {
    expect(clampLoop(null, 10)).toBeNull();
  });
});

describe("loopStart / loopEnd", () => {
  it("区間があればその両端", () => {
    expect(loopStart({ start: 1, end: 3 })).toBe(1);
    expect(loopEnd({ start: 1, end: 3 }, 10)).toBe(3);
  });

  it("区間が無ければ 0 秒〜全長（＝従来の全体ループ）", () => {
    expect(loopStart(null)).toBe(0);
    expect(loopEnd(null, 10)).toBe(10);
  });

  it("区間が全長を超えていたら全長で切る", () => {
    expect(loopEnd({ start: 1, end: 12 }, 10)).toBe(10);
  });
});
