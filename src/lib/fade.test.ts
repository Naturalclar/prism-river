import { describe, expect, it } from "vitest";
import { clampFades, rampSegment } from "./fade";

describe("clampFades", () => {
  it("keeps fades that fit", () => {
    expect(clampFades(3, 0.5, 1)).toEqual({ fi: 0.5, fo: 1 });
  });

  it("clamps each fade to the effective length", () => {
    expect(clampFades(2, 5, 0)).toEqual({ fi: 2, fo: 0 });
  });

  /* トリムで縮んだ後など、合計が実効長を超えるときはアウト側から詰める。 */
  it("shrinks the fade-out when the sum exceeds the length", () => {
    expect(clampFades(2, 1.5, 1.5)).toEqual({ fi: 1.5, fo: 0.5 });
  });

  it("treats negatives as zero", () => {
    expect(clampFades(2, -1, -1)).toEqual({ fi: 0, fo: 0 });
  });
});

describe("rampSegment", () => {
  it("keeps a future segment as-is", () => {
    expect(rampSegment(1, 0, 3, 1)).toEqual({ t0: 1, v0: 0, t1: 3, v1: 1 });
  });

  /* 途中から再生を始めたとき、ランプの現在値から張り直す。 */
  it("re-anchors a segment that started in the past", () => {
    expect(rampSegment(-1, 0, 3, 1)).toEqual({ t0: 0, v0: 0.25, t1: 3, v1: 1 });
  });

  it("drops a segment entirely in the past", () => {
    expect(rampSegment(-3, 0, -1, 1)).toBeNull();
  });
});
