import { describe, expect, it } from "vitest";
import {
  decodeRoll,
  emptyRoll,
  encodeRoll,
  isBlackKey,
  midiForRow,
  noteName,
  rollDuration,
  rollSteps,
  toMidiSong,
  toggleNote,
  ROLL_BASE_MIDI,
} from "./pianoroll";

describe("格子の寸法", () => {
  it("小節ぶん横に伸びる（ドラムのような繰り返しではない）", () => {
    expect(rollSteps(emptyRoll(120, 1))).toBe(16);
    expect(rollSteps(emptyRoll(120, 4))).toBe(64);
  });

  it("尺は bars 小節 × 4拍", () => {
    expect(rollDuration(emptyRoll(120, 1))).toBeCloseTo(2, 6);
    expect(rollDuration(emptyRoll(60, 2))).toBeCloseTo(8, 6);
  });
});

describe("行と音程", () => {
  it("一番下の行は C3、オクターブで 12 ずつ動く", () => {
    expect(midiForRow(0, 0)).toBe(ROLL_BASE_MIDI);
    expect(midiForRow(0, 1)).toBe(ROLL_BASE_MIDI + 12);
    expect(midiForRow(12, 0)).toBe(ROLL_BASE_MIDI + 12);
  });

  it("音名は MIDI 60 が C4", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(48)).toBe("C3");
  });

  it("黒鍵を判定する", () => {
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
  });
});

describe("toggleNote", () => {
  it("置く / もう一度押すと外す", () => {
    const one = toggleNote([], 0, 60, 1);
    expect(one).toEqual([{ step: 0, midi: 60, len: 1 }]);
    expect(toggleNote(one, 0, 60, 1)).toEqual([]);
  });

  it("同じ音程で重なる範囲は、あとから置いた方に揃える", () => {
    const long = toggleNote([], 0, 60, 4);
    const over = toggleNote(long, 2, 60, 1);
    /* 0..4 の音は退き、2 の音だけが残る（消したつもりの音が鳴り続けない）。 */
    expect(over).toEqual([{ step: 2, midi: 60, len: 1 }]);
  });

  it("音程が違えば重なっても両方残る（和音）", () => {
    const a = toggleNote([], 0, 60, 4);
    const b = toggleNote(a, 0, 64, 4);
    expect(b).toHaveLength(2);
  });

  it("隣り合うだけなら退けない", () => {
    const a = toggleNote([], 0, 60, 2);
    const b = toggleNote(a, 2, 60, 2);
    expect(b).toHaveLength(2);
  });
});

describe("toMidiSong", () => {
  it("ステップが秒になり、長さも刻みぶん伸びる", () => {
    const p = { ...emptyRoll(120, 1), notes: [{ step: 4, midi: 60, len: 2 }] };
    const song = toMidiSong(p);
    expect(song.notes).toHaveLength(1);
    expect(song.notes[0].startSec).toBeCloseTo(0.5, 6);
    expect(song.notes[0].durSec).toBeCloseTo(0.25, 6);
    expect(song.notes[0].midi).toBe(60);
  });

  it("音が途中で終わってもクリップの尺は格子の全長", () => {
    const p = { ...emptyRoll(120, 2), notes: [{ step: 0, midi: 60, len: 1 }] };
    expect(toMidiSong(p).durationSec).toBeCloseTo(4, 6);
  });

  it("右端をはみ出す音は端で切る", () => {
    const p = { ...emptyRoll(120, 1), notes: [{ step: 14, midi: 60, len: 8 }] };
    /* 残り 2 ステップぶんだけ鳴る。 */
    expect(toMidiSong(p).notes[0].durSec).toBeCloseTo(0.25, 6);
  });

  it("音色は program として全ノートに乗る", () => {
    const p = { ...emptyRoll(), program: 33, notes: [{ step: 0, midi: 60, len: 1 }] };
    expect(toMidiSong(p).notes[0].program).toBe(33);
  });

  it("空でも尺のある無音になる", () => {
    const song = toMidiSong(emptyRoll(120, 1));
    expect(song.notes).toEqual([]);
    expect(song.durationSec).toBeCloseTo(2, 6);
  });
});

describe("decodeRoll", () => {
  it("書いたものを読み戻せる", () => {
    const p = { ...emptyRoll(90, 2), program: 16, notes: [{ step: 3, midi: 62, len: 2 }] };
    expect(decodeRoll(encodeRoll(p))).toEqual(p);
  });

  it("壊れた JSON・型違いは null", () => {
    expect(decodeRoll("{")).toBeNull();
    expect(decodeRoll("null")).toBeNull();
    expect(decodeRoll(JSON.stringify({ bpm: 120 }))).toBeNull();
    expect(decodeRoll(JSON.stringify({ ...emptyRoll(), notes: [{ step: 0 }] }))).toBeNull();
  });

  it("範囲外の値はクランプ、格子の外のノートは捨てる", () => {
    const wild = {
      ...emptyRoll(9999, 42),
      octave: 9,
      program: 999,
      notes: [
        { step: 0, midi: 60, len: 1 },
        /* 1小節=16ステップに収まらない位置。 */
        { step: 999, midi: 60, len: 1 },
      ],
    };
    const got = decodeRoll(JSON.stringify(wild));
    expect(got?.bpm).toBe(240);
    expect(got?.bars).toBe(4);
    expect(got?.octave).toBe(2);
    expect(got?.program).toBe(127);
    expect(got?.notes).toEqual([{ step: 0, midi: 60, len: 1 }]);
  });
});
