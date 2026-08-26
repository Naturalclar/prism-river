import { describe, expect, it } from "vitest";
import {
  clamp,
  formatTime,
  panLabel,
  pickRulerStep,
  rulerLabel,
  rulerSubdivisions,
} from "./time";

describe("formatTime", () => {
  it("formats mm:ss.hh", () => {
    expect(formatTime(0)).toBe("00:00.00");
    expect(formatTime(1.5)).toBe("00:01.50");
    expect(formatTime(61.25)).toBe("01:01.25");
    expect(formatTime(600)).toBe("10:00.00");
  });

  /* 秒側だけを丸めると 59.999 が "60.00" になり 00:60.00 と表示される回帰。 */
  it("carries rounding into the minute instead of showing :60", () => {
    expect(formatTime(59.999)).toBe("01:00.00");
    expect(formatTime(59.9977)).toBe("01:00.00");
    expect(formatTime(119.996)).toBe("02:00.00");
    expect(formatTime(59.99)).toBe("00:59.99");
  });

  it("clamps junk to zero", () => {
    expect(formatTime(-3)).toBe("00:00.00");
    expect(formatTime(Number.NaN)).toBe("00:00.00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("00:00.00");
  });
});

describe("clamp", () => {
  it("keeps the value inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("panLabel", () => {
  it("names centre, left and right", () => {
    expect(panLabel(0)).toBe("C");
    expect(panLabel(-1)).toBe("L100");
    expect(panLabel(0.5)).toBe("R50");
  });
});

describe("pickRulerStep", () => {
  it("grows the step as the zoom shrinks", () => {
    expect(pickRulerStep(400)).toBe(0.25);
    expect(pickRulerStep(70)).toBe(1);
    expect(pickRulerStep(8)).toBe(10);
  });

  it("falls back to 600s when nothing fits", () => {
    expect(pickRulerStep(0.05)).toBe(600);
  });
});

describe("rulerLabel", () => {
  it("drops decimals when the step is a whole second", () => {
    expect(rulerLabel(61, 1)).toBe("01:01");
  });

  /* 桁を落とすと 00:00 / 00:00 / 00:01 … と同じラベルが並ぶ回帰。 */
  it("keeps one decimal on sub-second steps so labels stay distinct", () => {
    const labels = [0, 0.25, 0.5, 0.75].map((s) => rulerLabel(s, 0.25));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[1]).toBe("00:00.2");
  });
});

describe("rulerSubdivisions", () => {
  it("splits whole seconds into quarters and sub-second steps in half", () => {
    expect(rulerSubdivisions(1)).toBe(4);
    expect(rulerSubdivisions(0.5)).toBe(2);
  });
});
