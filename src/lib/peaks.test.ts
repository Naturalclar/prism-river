import { describe, expect, it } from "vitest";
import { computePeaks } from "./peaks";

describe("computePeaks", () => {
  it("folds each column to its min and max", () => {
    const s = new Float32Array([1, -1, 0.5, -0.25]);
    const p = computePeaks(s, 2);
    expect(p.cols).toBe(2);
    expect([...p.hi]).toEqual([1, 0.5]);
    expect([...p.lo]).toEqual([-1, -0.25]);
  });

  it("never reports a positive minimum or a negative maximum", () => {
    const p = computePeaks(new Float32Array([0.3, 0.4]), 1);
    expect(p.hi[0]).toBeCloseTo(0.4);
    expect(p.lo[0]).toBe(0);
  });

  it("survives an empty buffer", () => {
    const p = computePeaks(new Float32Array(0), 4);
    expect(p.cols).toBe(4);
    expect([...p.hi]).toEqual([0, 0, 0, 0]);
  });

  it("tracks the loudest sample even when columns cover many samples", () => {
    const s = new Float32Array(10_000);
    s[7777] = 0.9;
    const p = computePeaks(s, 10);
    expect(Math.max(...p.hi)).toBeCloseTo(0.9);
  });
});
