import { BARS_MAX, BARS_MIN, STEPS, barsDuration, clampBpm, clampNum, stepSec } from "./grid";
import type { MidiSong } from "./midi";

/**
 * ピアノロール（#55）。ブラウザ上でノートを置いて曲を作る。
 *
 * ノートは `lib/midi.ts` の `MidiNote` に開いてから `audio/midi.ts` の内蔵シンセに
 * 渡す。つまり**レンダー側は1行も変えずに鳴る**（読み込んだ MIDI と同じ経路）。
 *
 * ドラムの格子（#54）とは**小節の扱いが違う**。ドラムは同じ1小節を bars 回
 * 繰り返すが、メロディは小節ごとに中身が変わるので、格子は `bars × STEPS` の
 * 全長ぶん並ぶ（繰り返さない）。刻みと BPM の範囲は `lib/grid.ts` で共通。
 *
 * DOM に依存しないので vitest からそのまま叩ける（`lib/` の他と同じ方針）。
 */

/** 格子の縦の本数。2オクターブぶん並べる。 */
export const ROLL_ROWS = 24;

/** 一番下の行の音（C3）。オクターブシフトはこれを 12 単位で動かす。 */
export const ROLL_BASE_MIDI = 48;

export const OCTAVE_MIN = -2;
export const OCTAVE_MAX = 2;

/** 置くノートの長さ（ステップ数）。ドラッグでの伸縮は範囲外なので選択式にする。 */
export const NOTE_LENGTHS = [1, 2, 4, 8] as const;
export type NoteLength = (typeof NOTE_LENGTHS)[number];

/** 音色。内蔵シンセは GM の program から波形を決めるので、代表値を並べる。 */
export const TONES = [
  { program: 0, label: "ピアノ" },
  { program: 16, label: "オルガン" },
  { program: 33, label: "ベース" },
  { program: 80, label: "リード" },
] as const;

/** 1音。`step` は格子の左端からの通し番号（小節はまたぐ）。 */
export type RollNote = { step: number; midi: number; len: number };

export type RollPattern = {
  bpm: number;
  bars: number;
  /** 格子の表示位置。音そのものは `notes[].midi` が正本。 */
  octave: number;
  program: number;
  notes: RollNote[];
};

export function emptyRoll(bpm = 120, bars = 1): RollPattern {
  return { bpm, bars, octave: 0, program: 0, notes: [] };
}

/** 格子の総ステップ数。ドラムと違い、小節ぶんが横に伸びる。 */
export function rollSteps(p: RollPattern): number {
  return STEPS * clampNum(p.bars, BARS_MIN, BARS_MAX);
}

/** クリップの尺。ノートが途中で終わってもここまでは伸ばす（拍を保つため）。 */
export function rollDuration(p: RollPattern): number {
  return barsDuration(p.bpm, p.bars);
}

/** 格子の行（0 が一番下）を MIDI ノート番号に直す。 */
export function midiForRow(row: number, octave: number): number {
  return ROLL_BASE_MIDI + clampNum(octave, OCTAVE_MIN, OCTAVE_MAX) * 12 + row;
}

/** 黒鍵の行。格子の背景を分けて、目で音程を追えるようにする。 */
export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** 表示用の音名（C4 など）。MIDI 60 を C4 とする一般的な表記。 */
export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

const byPosition = (a: RollNote, b: RollNote) => a.step - b.step || a.midi - b.midi;

/**
 * ノートを置く / 外す。同じ位置に既にあれば外す（格子のトグルと同じ操作感）。
 * 長さが重なった同じ音程のノートは**あとから置いた方に揃える**——重なったまま
 * 残すと、消したつもりの音が鳴り続けて気づけない。
 */
export function toggleNote(
  notes: RollNote[],
  step: number,
  midi: number,
  len: NoteLength,
): RollNote[] {
  const hit = notes.find((n) => n.midi === midi && n.step === step);
  if (hit) return notes.filter((n) => n !== hit);
  const end = step + len;
  /* 同じ音程で範囲がかぶるものは退ける。 */
  const kept = notes.filter((n) => n.midi !== midi || n.step + n.len <= step || n.step >= end);
  /* 新しい配列を作ってから並べるので、元の notes は書き換わらない。 */
  // oxlint-disable-next-line no-array-sort
  return [...kept, { step, midi, len }].sort(byPosition);
}

/**
 * 内蔵シンセに渡せる形に開く。`durationSec` を格子の全長にしておくと、
 * ノートが途中で終わってもクリップの尺が縮まない。
 */
export function toMidiSong(p: RollPattern): MidiSong {
  const sec = stepSec(p.bpm);
  const total = rollSteps(p);
  /* 内蔵シンセの同時発音数の見積もり（audio/midi.ts）はノートが開始順に
     並んでいることを前提にしているので、ここで必ず揃えてから渡す。
     複製してから並べるので、元の notes は書き換わらない。 */
  // oxlint-disable-next-line no-array-sort
  const ordered = [...p.notes].sort(byPosition);
  return {
    notes: ordered
      .filter((n) => n.step < total)
      .map((n) => ({
        startSec: n.step * sec,
        /* 格子の右端をはみ出す音は端で切る。 */
        durSec: Math.min(n.len, total - n.step) * sec,
        midi: n.midi,
        velocity: 100,
        channel: 0,
        program: p.program,
      })),
    durationSec: rollDuration(p),
    format: 0,
    channels: [0],
  };
}

/* ── 保存・復元（#18）用の符号化 ─────────────────────────────────────── */

export function encodeRoll(p: RollPattern): string {
  return JSON.stringify(p);
}

function isNote(v: unknown): v is RollNote {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.step === "number" &&
    Number.isFinite(n.step) &&
    typeof n.midi === "number" &&
    Number.isFinite(n.midi) &&
    typeof n.len === "number" &&
    Number.isFinite(n.len)
  );
}

/**
 * 保存されたロールを検証して返す。壊れていれば null（呼び出し側で伝える）。
 * 生成トラックには元ファイルが無いので、**このデータが音の正本**になる。
 */
export function decodeRoll(json: string): RollPattern | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.bpm !== "number" || !Number.isFinite(p.bpm)) return null;
  if (typeof p.bars !== "number" || !Number.isFinite(p.bars)) return null;
  if (typeof p.octave !== "number" || !Number.isFinite(p.octave)) return null;
  if (typeof p.program !== "number" || !Number.isFinite(p.program)) return null;
  if (!Array.isArray(p.notes) || !p.notes.every(isNote)) return null;
  const bars = clampNum(Math.round(p.bars), BARS_MIN, BARS_MAX);
  const total = STEPS * bars;
  return {
    bpm: clampBpm(p.bpm),
    bars,
    octave: clampNum(Math.round(p.octave), OCTAVE_MIN, OCTAVE_MAX),
    program: clampNum(Math.round(p.program), 0, 127),
    /* 範囲外のノートは捨てる。鳴らないのに格子から消せない音が残るのを避ける。 */
    notes: (p.notes as RollNote[])
      .filter((n) => n.step >= 0 && n.step < total && n.midi >= 0 && n.midi <= 127 && n.len >= 1)
      .map((n) => ({ step: Math.round(n.step), midi: Math.round(n.midi), len: Math.round(n.len) })),
  };
}
