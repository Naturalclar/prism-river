/**
 * ドラムパターン（#54）。
 *
 * パターンは「16分音符 × 16ステップ × 音色」の格子というプレーンなデータで、
 * ここでは秒への展開だけを行う。音を出すのは `src/audio/drums.ts`。
 *
 * サンプル音源を同梱しない（制約「権利のあるファイルをコミットしない」）ので、
 * 音は Web Audio の標準ノードで合成する。つまりリポジトリに増えるバイト数は
 * ゼロで、依存も増えない。
 *
 * DOM に依存しないので vitest からそのまま叩ける（`lib/` の他と同じ方針）。
 */

/** 音色。増やすなら格子の行が増えるだけで、展開もレンダーも変わらない。 */
export const DRUM_VOICES = ["kick", "snare", "hatClosed", "hatOpen"] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];

export const VOICE_LABEL: Record<DrumVoice, string> = {
  kick: "キック",
  snare: "スネア",
  hatClosed: "ハイハット",
  hatOpen: "オープンハット",
};

/** 1小節あたりのステップ数。16分音符なので 4拍 × 4。 */
export const STEPS = 16;

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const BARS_MIN = 1;
export const BARS_MAX = 4;

export type DrumPattern = {
  bpm: number;
  /** 何小節ぶん繰り返すか。展開して1本の AudioBuffer にする。 */
  bars: number;
  hits: Record<DrumVoice, boolean[]>;
};

/**
 * 展開後の1発。レンダー側はこれを順に鳴らすだけでよい。
 * `velocity` は 0..1 の強さ（格子は 1 固定、MIDI はノートの強弱が入る・#58）。
 */
export type DrumHit = { voice: DrumVoice; atSec: number; velocity: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 1ステップ（16分音符）の長さ（秒）。120BPM なら 0.125s。 */
export function stepSec(bpm: number): number {
  return 60 / clamp(bpm, BPM_MIN, BPM_MAX) / (STEPS / 4);
}

/** パターン全体の長さ（秒）。`bars 小節 × 4拍`。 */
export function patternDuration(p: DrumPattern): number {
  return stepSec(p.bpm) * STEPS * clamp(p.bars, BARS_MIN, BARS_MAX);
}

const emptyRow = (): boolean[] => Array.from({ length: STEPS }, () => false);

export function emptyPattern(bpm = 120, bars = 2): DrumPattern {
  return {
    bpm,
    bars,
    hits: { kick: emptyRow(), snare: emptyRow(), hatClosed: emptyRow(), hatOpen: emptyRow() },
  };
}

/** `"x"` の位置が発音。読みやすさのためにプリセットは文字列で書く。 */
function row(spec: string): boolean[] {
  const r = emptyRow();
  for (let i = 0; i < Math.min(STEPS, spec.length); i++) r[i] = spec[i] === "x";
  return r;
}

export type PresetId = "empty" | "four" | "eight" | "shuffle";

export const PRESET_LABEL: Record<PresetId, string> = {
  empty: "クリア",
  four: "四つ打ち",
  eight: "8ビート",
  shuffle: "シャッフル",
};

export const PRESET_IDS: readonly PresetId[] = ["four", "eight", "shuffle", "empty"];

/** 空の格子から始めさせないための下敷き。BPM と小節数は今の値を引き継ぐ。 */
export function presetHits(id: PresetId): DrumPattern["hits"] {
  switch (id) {
    case "four":
      return {
        kick: row("x...x...x...x..."),
        snare: row("................"),
        hatClosed: row("..x...x...x...x."),
        hatOpen: row("................"),
      };
    case "eight":
      return {
        kick: row("x.......x......."),
        snare: row("....x.......x..."),
        hatClosed: row("x.x.x.x.x.x.x.x."),
        hatOpen: row("................"),
      };
    case "shuffle":
      return {
        kick: row("x.....x.....x..."),
        snare: row("....x.......x..."),
        hatClosed: row("x..x..x..x..x..x"),
        hatOpen: row("................"),
      };
    case "empty":
      return emptyPattern().hits;
  }
}

/**
 * 格子を発音イベント列に開く。小節の繰り返しはここで潰すので、レンダー側は
 * ループの仕組みを持たなくてよい（既存の「1トラック＝1 AudioBuffer」に乗る）。
 */
export function expandPattern(p: DrumPattern): DrumHit[] {
  const step = stepSec(p.bpm);
  const bars = clamp(p.bars, BARS_MIN, BARS_MAX);
  const hits: DrumHit[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < STEPS; i++) {
      for (const voice of DRUM_VOICES) {
        if (p.hits[voice][i]) hits.push({ voice, atSec: (bar * STEPS + i) * step, velocity: 1 });
      }
    }
  }
  return hits;
}

/* ── GM パーカッション（#58） ─────────────────────────────────────────── */

/**
 * MIDI チャンネル10 のノート番号を音色に対応づける（GM のドラムマップ）。
 * 音色は4つしか無いので**全部は鳴らせない**。対応が無いものは null を返し、
 * 呼び出し側が本数を数えて伝える（黙って落とさない）。
 */
export function voiceForGmNote(note: number): DrumVoice | null {
  /* 35 アコースティックバスドラム / 36 バスドラム1 */
  if (note === 35 || note === 36) return "kick";
  /* 37 サイドスティック / 38 アコースティックスネア / 39 ハンドクラップ / 40 エレクトリックスネア */
  if (note >= 37 && note <= 40) return "snare";
  /* 42 クローズドハイハット / 44 ペダルハイハット */
  if (note === 42 || note === 44) return "hatClosed";
  /* 46 オープンハイハット。49/51/57/59 のシンバル類も、余韻の長いノイズが
     一番近いので同じ音色を当てる（タム類は近いものが無いので鳴らさない）。 */
  if (note === 46 || note === 49 || note === 51 || note === 57 || note === 59) return "hatOpen";
  return null;
}

/* ── 保存・復元（#18）用の符号化 ─────────────────────────────────────── */

export function encodeDrumPattern(p: DrumPattern): string {
  return JSON.stringify(p);
}

const isRow = (v: unknown): v is boolean[] =>
  Array.isArray(v) && v.length === STEPS && v.every((x) => typeof x === "boolean");

/**
 * 保存されたパターンを検証して返す。壊れていれば null（呼び出し側で伝える）。
 * 生成トラックには元ファイルが無いので、**このデータが音の正本**になる。
 */
export function decodeDrumPattern(json: string): DrumPattern | null {
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
  if (typeof p.hits !== "object" || p.hits === null) return null;
  const hits = p.hits as Record<string, unknown>;
  if (!DRUM_VOICES.every((voice) => isRow(hits[voice]))) return null;
  return {
    bpm: clamp(p.bpm, BPM_MIN, BPM_MAX),
    bars: clamp(Math.round(p.bars), BARS_MIN, BARS_MAX),
    hits: {
      kick: [...(hits.kick as boolean[])],
      snare: [...(hits.snare as boolean[])],
      hatClosed: [...(hits.hatClosed as boolean[])],
      hatOpen: [...(hits.hatOpen as boolean[])],
    },
  };
}
