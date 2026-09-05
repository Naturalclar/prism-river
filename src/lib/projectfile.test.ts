import { describe, expect, it } from "vitest";
import { defaultFxMeta, PROJECT_VERSION, type ProjectMeta } from "./store";
import { buildZip } from "./zip";
import { audioEntryName, packProject, unpackProject } from "./projectfile";

const meta: ProjectMeta = {
  version: PROJECT_VERSION,
  savedAt: 1756200000000,
  masterVol: 0.9,
  pxPerSec: 70,
  busVol: { strings: 1, winds: 0.5, keys: 1 },
  tracks: [
    {
      name: "a",
      srcName: "a.mp3",
      vol: 0.5,
      panv: 0,
      mute: false,
      solo: false,
      offset: 1,
      trimStart: 0,
      trimEnd: 2,
      fadeIn: 0,
      fadeOut: 0,
      fx: defaultFxMeta(),
      color: "#6E8FD4",
      bus: "strings",
    },
    {
      name: "ドラム 1",
      srcName: "ドラム 1.drums.json",
      vol: 0.85,
      panv: 0,
      mute: false,
      solo: false,
      offset: 0,
      trimStart: 0,
      trimEnd: 2,
      fadeIn: 0,
      fadeOut: 0,
      fx: defaultFxMeta(),
      color: "#E8735A",
    },
  ],
};

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe("packProject / unpackProject", () => {
  it("往復でメタと音声が戻る", async () => {
    const blobs = [new Blob([new Uint8Array([1, 2, 3])]), new Blob(['{"bpm":120}'])];
    const file = await packProject(meta, blobs);
    const r = unpackProject(await bytes(file));
    if ("error" in r) throw new Error(r.error);
    expect(r.meta).toEqual(meta);
    expect(await bytes(r.blobs[0])).toEqual(new Uint8Array([1, 2, 3]));
    expect(await r.blobs[1].text()).toBe('{"bpm":120}');
  });

  it("音声の項目名は元ファイルの拡張子を残す（復元側が拡張子で経路を選ぶ）", () => {
    expect(audioEntryName(0, "a.mp3")).toBe("audio/0.mp3");
    expect(audioEntryName(3, "ドラム 1.drums.json")).toBe("audio/3.json");
    expect(audioEntryName(1, "noext")).toBe("audio/1.bin");
  });

  it("ZIP でないものは理由つきで断る", () => {
    const r = unpackProject(new TextEncoder().encode("garbage"));
    expect("error" in r && r.error).toMatch(/プロジェクトファイルとして読めません/);
  });

  it("project.json が無い ZIP は断る", () => {
    const z = buildZip([{ name: "readme.txt", data: new Uint8Array([1]) }]);
    const r = unpackProject(z);
    expect("error" in r && r.error).toMatch(/project\.json/);
  });

  it("新しい版のファイルは「新しい版」だと伝える", () => {
    const z = buildZip([
      {
        name: "project.json",
        data: new TextEncoder().encode(JSON.stringify({ ...meta, version: PROJECT_VERSION + 1 })),
      },
    ]);
    const r = unpackProject(z);
    expect("error" in r && r.error).toMatch(/新しい版/);
  });

  it("壊れた project.json は破損だと伝える", () => {
    const z = buildZip([{ name: "project.json", data: new TextEncoder().encode("{oops") }]);
    const r = unpackProject(z);
    expect("error" in r && r.error).toMatch(/壊れています/);
  });

  it("音声が欠けていたら、どの項目が無いか伝える", async () => {
    const file = await packProject(meta, [new Blob([new Uint8Array([1])])]);
    const r = unpackProject(await bytes(file));
    expect("error" in r && r.error).toMatch(/audio\/1\.json/);
  });
});
