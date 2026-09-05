import { describe, expect, it } from "vitest";
import { buildZip, crc32, readZip, ZipError } from "./zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("crc32", () => {
  it("既知の値と一致する（他のツールと同じ ZIP になる根拠）", () => {
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildZip / readZip", () => {
  it("往復で名前と中身が戻る（UTF-8 の名前・バイナリ・空ファイル）", () => {
    const entries = [
      { name: "project.json", data: enc.encode('{"version":2}') },
      { name: "audio/0.mp3", data: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]) },
      { name: "audio/録音 1.webm", data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) },
      { name: "empty", data: new Uint8Array(0) },
    ];
    const back = readZip(buildZip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) expect(back[i].data).toEqual(entries[i].data);
    expect(dec.decode(back[0].data)).toBe('{"version":2}');
  });

  it("ヘッダは無圧縮（stored）で、他のツールが読める形になっている", () => {
    const z = buildZip([{ name: "a", data: enc.encode("x") }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50); /* local header */
    expect(v.getUint16(8, true)).toBe(0); /* method stored */
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50); /* EOCD */
  });

  it("ZIP でないものは理由つきで断る", () => {
    expect(() => readZip(enc.encode("not a zip"))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(0))).toThrow(/ZIP として読めません/);
  });

  it("途中で切れた ZIP は断る（中身を黙って欠けさせない）", () => {
    const z = buildZip([{ name: "a", data: enc.encode("hello world") }]);
    /* ディレクトリは残し、データ部だけ壊す → CRC 不一致。 */
    const broken = z.slice();
    broken[30 + 1] ^= 0xff;
    expect(() => readZip(broken)).toThrow(/CRC/);
  });

  it("圧縮された項目は断る（stored 以外は対応外だと分かる文言）", () => {
    const z = buildZip([{ name: "a", data: enc.encode("x") }]);
    const v = new DataView(z.buffer);
    /* 中央ディレクトリの method を deflate(8) に書き換える。 */
    const centralAt = v.getUint32(z.length - 22 + 16, true);
    v.setUint16(centralAt + 10, 8, true);
    expect(() => readZip(z)).toThrow(/圧縮された ZIP/);
  });
});
