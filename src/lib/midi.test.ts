import { describe, expect, it } from "vitest";
import { DRUM_CHANNEL, midiToHz, MidiParseError, parseSmf } from "./midi";

/* テスト用に SMF を組み立てる。実ファイルを置かずにバイト列で検証するため。 */

function varInt(n: number): number[] {
  const out = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function chunk(id: string, body: number[]): number[] {
  const len = body.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...body,
  ];
}

function header(format: number, ntrks: number, division: number): number[] {
  return chunk("MThd", [
    (format >> 8) & 0xff,
    format & 0xff,
    (ntrks >> 8) & 0xff,
    ntrks & 0xff,
    (division >> 8) & 0xff,
    division & 0xff,
  ]);
}

const END = [0x00, 0xff, 0x2f, 0x00];

/** マイクロ秒/四分音符のテンポメタ。 */
function tempo(delta: number, usPerQuarter: number): number[] {
  return [
    ...varInt(delta),
    0xff,
    0x51,
    0x03,
    (usPerQuarter >> 16) & 0xff,
    (usPerQuarter >> 8) & 0xff,
    usPerQuarter & 0xff,
  ];
}

const smf = (tracks: number[][], format = tracks.length > 1 ? 1 : 0, division = 480) =>
  new Uint8Array([
    ...header(format, tracks.length, division),
    ...tracks.flatMap((t) => chunk("MTrk", [...t, ...END])),
  ]);

describe("parseSmf", () => {
  it("四分音符1音を既定テンポ(120BPM)で 0.5 秒に開く", () => {
    /* 480 tick = 四分音符 = 0.5s（120BPM の既定テンポ） */
    const song = parseSmf(smf([[...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0]]));
    expect(song.notes).toHaveLength(1);
    expect(song.notes[0].midi).toBe(60);
    expect(song.notes[0].velocity).toBe(100);
    expect(song.notes[0].startSec).toBeCloseTo(0, 5);
    expect(song.notes[0].durSec).toBeCloseTo(0.5, 5);
    expect(song.durationSec).toBeCloseTo(0.5, 5);
    expect(song.format).toBe(0);
    expect(song.channels).toEqual([0]);
  });

  it("テンポメタが効く（60BPM なら四分音符は 1 秒）", () => {
    const song = parseSmf(
      smf([[...tempo(0, 1_000_000), ...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0]]),
    );
    expect(song.notes[0].durSec).toBeCloseTo(1, 5);
  });

  it("途中のテンポチェンジも畳んで秒に直す", () => {
    /* 0..480 は 120BPM(0.5s)、そこから 60BPM に変わって次の音は 1 秒 */
    const song = parseSmf(
      smf([
        [
          ...varInt(0), 0x90, 60, 100,
          ...varInt(480), 0x80, 60, 0,
          ...tempo(0, 1_000_000),
          ...varInt(0), 0x90, 62, 100,
          ...varInt(480), 0x80, 62, 0,
        ],
      ]),
    );
    const [first, second] = song.notes;
    expect(first.durSec).toBeCloseTo(0.5, 5);
    expect(second.startSec).toBeCloseTo(0.5, 5);
    expect(second.durSec).toBeCloseTo(1, 5);
    expect(song.durationSec).toBeCloseTo(1.5, 5);
  });

  it("running status（ステータスバイト省略）を解釈する", () => {
    const song = parseSmf(
      smf([
        [
          ...varInt(0), 0x90, 60, 100,
          /* 以降は 0x90 を省略 */
          ...varInt(0), 64, 100,
          ...varInt(480), 60, 0,
          ...varInt(0), 64, 0,
        ],
      ]),
    );
    expect(song.notes).toHaveLength(2);
    // oxlint-disable-next-line no-array-sort -- map が返した新しい配列
    expect(song.notes.map((n) => n.midi).sort()).toEqual([60, 64]);
    expect(song.notes.every((n) => n.durSec > 0.4)).toBe(true);
  });

  it("velocity 0 の note on は note off として閉じる", () => {
    const song = parseSmf(smf([[...varInt(0), 0x90, 60, 100, ...varInt(240), 0x90, 60, 0]]));
    expect(song.notes).toHaveLength(1);
    expect(song.notes[0].durSec).toBeCloseTo(0.25, 5);
  });

  it("program change が発音時点の音色として乗る", () => {
    const song = parseSmf(
      smf([[...varInt(0), 0xc0, 40, ...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0]]),
    );
    expect(song.notes[0].program).toBe(40);
  });

  it("format 1 の複数トラックをチャンネルごとに拾う", () => {
    const song = parseSmf(
      smf([
        [...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0],
        [...varInt(0), 0x91, 67, 90, ...varInt(480), 0x81, 67, 0],
        [...varInt(0), 0x99, 36, 110, ...varInt(240), 0x89, 36, 0],
      ]),
    );
    expect(song.format).toBe(1);
    expect(song.channels).toEqual([0, 1, DRUM_CHANNEL]);
    expect(song.notes).toHaveLength(3);
  });

  it("note off が来ないまま終わる音も長さを持って閉じる", () => {
    const song = parseSmf(smf([[...varInt(0), 0x90, 60, 100, ...varInt(480), 0x90, 62, 100]]));
    expect(song.notes).toHaveLength(2);
    expect(song.notes.every((n) => n.durSec > 0)).toBe(true);
  });

  /* 以下は「ブラウザが対応していない」ではなく理由を伝えるための分岐（#46）。 */

  it("MThd が無ければ理由つきで失敗する", () => {
    expect(() => parseSmf(new Uint8Array([1, 2, 3, 4]))).toThrow(MidiParseError);
    expect(() => parseSmf(new Uint8Array(20))).toThrow(/MThd/);
  });

  it("format 2 は理由つきで拒否する", () => {
    const bytes = smf([[...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0]], 2);
    expect(() => parseSmf(bytes)).toThrow(/format 2/);
  });

  it("SMPTE division は理由つきで拒否する", () => {
    const bytes = smf([[...varInt(0), 0x90, 60, 100, ...varInt(480), 0x80, 60, 0]], 0, 0xe278);
    expect(() => parseSmf(bytes)).toThrow(/SMPTE/);
  });

  it("ノートが1つも無ければ理由つきで失敗する", () => {
    expect(() => parseSmf(smf([[...tempo(0, 500_000)]]))).toThrow(/ノート/);
  });
});

describe("midiToHz", () => {
  it("A4 = 69 が 440Hz、オクターブで倍になる", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(81)).toBeCloseTo(880, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
  });
});
