import { describe, expect, it } from "vitest";
import { decodeMeta, encodeMeta, PROJECT_VERSION, type ProjectMeta } from "./store";

const track = {
  name: "a",
  srcName: "a.wav",
  vol: 0.85,
  panv: -0.2,
  mute: false,
  solo: true,
  offset: 1.5,
  trimStart: 0.25,
  trimEnd: 2,
  fadeIn: 0.1,
  fadeOut: 0,
  color: "#6E8FD4",
};

const meta: ProjectMeta = {
  version: PROJECT_VERSION,
  savedAt: 1756200000000,
  masterVol: 0.9,
  pxPerSec: 70,
  tracks: [track],
};

describe("decodeMeta", () => {
  it("encodeMeta との往復で同じ値に戻る", () => {
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
  });

  it("保存が無い（null）なら null", () => {
    expect(decodeMeta(null)).toBeNull();
  });

  it("JSON として壊れていたら null（例外を投げない）", () => {
    expect(decodeMeta("{oops")).toBeNull();
    expect(decodeMeta('"string"')).toBeNull();
  });

  it("版が違えば null（将来の形式を今のコードで誤読しない）", () => {
    expect(decodeMeta(encodeMeta({ ...meta, version: PROJECT_VERSION + 1 }))).toBeNull();
  });

  it("トラックの必須フィールドが欠けていたら null", () => {
    const { vol: _vol, ...broken } = track;
    const json = JSON.stringify({ ...meta, tracks: [broken] });
    expect(decodeMeta(json)).toBeNull();
  });

  it("数値フィールドに数でない値が入っていたら null", () => {
    const json = JSON.stringify({ ...meta, tracks: [{ ...track, offset: "1.5" }] });
    expect(decodeMeta(json)).toBeNull();
    expect(decodeMeta(JSON.stringify({ ...meta, masterVol: null }))).toBeNull();
  });

  it("tracks が配列でなければ null", () => {
    expect(decodeMeta(JSON.stringify({ ...meta, tracks: {} }))).toBeNull();
  });
});
