import { describe, expect, it } from "vitest";
import { decodeMeta, defaultFxMeta, encodeMeta, PROJECT_VERSION, type ProjectMeta } from "./store";

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
  fx: {
    eq: { low: -6, mid: 2, high: 0 },
    comp: { on: true, threshold: -30, ratio: 8, attack: 0.01, release: 0.4 },
  },
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

  it("版が新しければ null（将来の形式を今のコードで誤読しない）", () => {
    expect(decodeMeta(encodeMeta({ ...meta, version: PROJECT_VERSION + 1 }))).toBeNull();
  });

  /* v1（fx 無し）の保存データは fx を既定値で補って読む（後方互換）。 */
  it("v1 のデータは fx を既定値で補って読める", () => {
    const { fx: _fx, ...v1track } = track;
    const json = JSON.stringify({ ...meta, version: 1, tracks: [v1track] });
    const decoded = decodeMeta(json);
    expect(decoded?.version).toBe(PROJECT_VERSION);
    expect(decoded?.tracks[0].fx).toEqual(defaultFxMeta());
    expect(decoded?.tracks[0].vol).toBe(track.vol);
  });

  it("v2 で fx が壊れていたら null", () => {
    const broken = { ...track, fx: { eq: { low: 0, mid: 0 }, comp: track.fx.comp } };
    expect(decodeMeta(JSON.stringify({ ...meta, tracks: [broken] }))).toBeNull();
    const badComp = { ...track, fx: { eq: track.fx.eq, comp: { ...track.fx.comp, on: "yes" } } };
    expect(decodeMeta(JSON.stringify({ ...meta, tracks: [badComp] }))).toBeNull();
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
