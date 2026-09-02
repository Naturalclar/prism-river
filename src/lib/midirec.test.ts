import { describe, expect, it } from "vitest";
import {
  decodeMidiRec,
  encodeMidiRec,
  MIDIREC_VERSION,
  notesFromEvents,
  parseMidiMessage,
  songFromEvents,
  type MidiInEvent,
} from "./midirec";

const on = (atSec: number, midi: number, velocity = 100, channel = 0): MidiInEvent => ({
  atSec,
  kind: "on",
  midi,
  velocity,
  channel,
});
const off = (atSec: number, midi: number, channel = 0): MidiInEvent => ({
  atSec,
  kind: "off",
  midi,
  velocity: 0,
  channel,
});

describe("parseMidiMessage", () => {
  it("note on / off を読む", () => {
    expect(parseMidiMessage([0x90, 69, 100], 1.5)).toEqual({
      atSec: 1.5,
      kind: "on",
      midi: 69,
      velocity: 100,
      channel: 0,
    });
    expect(parseMidiMessage([0x83, 60, 0], 2)).toEqual({
      atSec: 2,
      kind: "off",
      midi: 60,
      velocity: 0,
      channel: 3,
    });
  });

  it("velocity 0 の note on は note off（よく使われる省略形）", () => {
    expect(parseMidiMessage([0x90, 69, 0], 1)?.kind).toBe("off");
  });

  it("ノート以外（CC / ピッチベンド）と短すぎるデータは null", () => {
    expect(parseMidiMessage([0xb0, 1, 64], 0)).toBeNull();
    expect(parseMidiMessage([0xe0, 0, 64], 0)).toBeNull();
    expect(parseMidiMessage([0x90, 69], 0)).toBeNull();
  });
});

describe("notesFromEvents", () => {
  it("on と off を対にして1音にする", () => {
    const notes = notesFromEvents([on(0.5, 69), off(1.0, 69)], 2);
    expect(notes).toHaveLength(1);
    expect(notes[0].startSec).toBeCloseTo(0.5);
    expect(notes[0].durSec).toBeCloseTo(0.5);
    expect(notes[0].midi).toBe(69);
  });

  it("off が来ないまま停止した音は endSec で閉じる", () => {
    const notes = notesFromEvents([on(1, 60)], 3);
    expect(notes[0].durSec).toBeCloseTo(2);
  });

  it("off だけが来た音は捨てる（対応する on が無い）", () => {
    expect(notesFromEvents([off(1, 60)], 2)).toHaveLength(0);
  });

  it("同じ音の重なりは後着の off から先着に閉じず、スタックで対応づける", () => {
    const notes = notesFromEvents([on(0, 60), on(0.5, 60), off(1, 60), off(2, 60)], 3);
    expect(notes).toHaveLength(2);
    /* 後に押した方が先の off で閉じる（スタック）。合計の長さで確かめる。 */
    const durs = notes.map((n) => n.durSec);
    expect(Math.min(...durs)).toBeCloseTo(0.5);
    expect(Math.max(...durs)).toBeCloseTo(2);
  });

  it("チャンネルが違う同じノート番号は混ざらない", () => {
    const notes = notesFromEvents([on(0, 60, 100, 0), on(0, 60, 100, 9), off(1, 60, 9)], 2);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.channel === 9)?.durSec).toBeCloseTo(1);
    expect(notes.find((n) => n.channel === 0)?.durSec).toBeCloseTo(2);
  });
});

describe("songFromEvents", () => {
  it("ノートが無ければ null（空録音はトラックにしない）", () => {
    expect(songFromEvents([], 5)).toBeNull();
  });

  it("durationSec は最後のノートの終端", () => {
    const song = songFromEvents([on(0, 60), off(1, 60), on(2, 64), off(2.5, 64)], 10);
    expect(song?.durationSec).toBeCloseTo(2.5);
    expect(song?.channels).toEqual([0]);
  });
});

describe("encodeMidiRec / decodeMidiRec", () => {
  it("往復で同じノート列に戻る", () => {
    const song = songFromEvents([on(0.25, 69, 90), off(1.25, 69)], 2);
    if (!song) throw new Error("song should exist");
    const back = decodeMidiRec(encodeMidiRec(song));
    expect(back?.notes).toEqual(song.notes);
    expect(back?.durationSec).toBeCloseTo(song.durationSec);
  });

  it("壊れた JSON・版違い・空ノートは null", () => {
    expect(decodeMidiRec("{oops")).toBeNull();
    expect(decodeMidiRec(JSON.stringify({ version: MIDIREC_VERSION + 1, notes: [] }))).toBeNull();
    expect(decodeMidiRec(JSON.stringify({ version: MIDIREC_VERSION, notes: [] }))).toBeNull();
    expect(
      decodeMidiRec(JSON.stringify({ version: MIDIREC_VERSION, notes: [{ startSec: "0" }] })),
    ).toBeNull();
  });

  it("範囲外の値はクランプして読む", () => {
    const json = JSON.stringify({
      version: MIDIREC_VERSION,
      notes: [{ startSec: -1, durSec: 0, midi: 300, velocity: 0, channel: 99, program: -5 }],
    });
    const song = decodeMidiRec(json);
    expect(song?.notes[0]).toEqual({
      startSec: 0,
      durSec: 0.01,
      midi: 127,
      velocity: 1,
      channel: 15,
      program: 0,
    });
  });
});
