import { describe, expect, it } from "vitest";
import { MIN_CLIP, trimEndTo, trimStartTo, type ClipSpan } from "./trim";

const span = (offset: number, trimStart: number, trimEnd: number): ClipSpan => ({
  offset,
  trimStart,
  trimEnd,
});

describe("trimEndTo", () => {
  it("trims the tail", () => {
    expect(trimEndTo(span(0, 0, 3), 3, 2)).toEqual(span(0, 0, 2));
  });

  it("cannot extend past the buffer", () => {
    expect(trimEndTo(span(0, 0, 2), 3, 99)).toEqual(span(0, 0, 3));
  });

  it("stops at the minimum clip length", () => {
    expect(trimEndTo(span(0, 1, 3), 3, 0)).toEqual(span(0, 1, 1 + MIN_CLIP));
  });
});

describe("trimStartTo", () => {
  it("trims the head and shifts the offset so the timeline position stays", () => {
    expect(trimStartTo(span(2, 0, 3), 0.5)).toEqual(span(2.5, 0.5, 3));
  });

  it("restoring the head pulls the offset back", () => {
    expect(trimStartTo(span(2.5, 0.5, 3), 0)).toEqual(span(2, 0, 3));
  });

  /* offset を 0 未満にはできないので、その分しか頭を戻せない。 */
  it("cannot restore past offset zero", () => {
    expect(trimStartTo(span(0.3, 1, 3), 0)).toEqual(span(0, 0.7, 3));
  });

  it("stops at the minimum clip length", () => {
    expect(trimStartTo(span(0, 0, 1), 99)).toEqual(span(1 - MIN_CLIP, 1 - MIN_CLIP, 1));
  });
});
