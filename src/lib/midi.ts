/**
 * SMF（Standard MIDI File）の解析（#46）。
 *
 * MIDI は音声ではなく音符イベントなので、`decodeAudioData` では永久に読めない。
 * ここでバイト列をノート列に開き、`src/audio/midi.ts` が内蔵シンセで
 * オフラインレンダーして普通の AudioBuffer にする。
 *
 * DOM に依存しないので vitest からそのまま叩ける（`lib/` の他と同じ方針）。
 */

/** 1音。時刻は秒に直してある（tick とテンポマップはここで解決済み）。 */
export type MidiNote = {
  startSec: number;
  durSec: number;
  /** ノート番号 0..127。60 が中央ド。 */
  midi: number;
  /** 1..127。 */
  velocity: number;
  /** 0..15。9（0 始まりのチャンネル10）はドラム。 */
  channel: number;
  /** 発音時点でそのチャンネルに効いていた GM プログラム番号 0..127。 */
  program: number;
};

export type MidiSong = {
  notes: MidiNote[];
  durationSec: number;
  /** format 0 / 1。 */
  format: number;
  /** 使われているチャンネル（昇順）。 */
  channels: number[];
};

/** 解析できない理由を伝えるための型。呼び出し側はこの message をそのまま出せる。 */
export class MidiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiParseError";
  }
}

const TEXT = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));

/** 実装の上限。壊れたファイルで無限ループしないための保険。 */
const MAX_NOTES = 200_000;

type Cursor = { at: number };

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

/** 可変長数値（1バイト7bit + 継続フラグ）。 */
function readVarInt(b: Uint8Array, c: Cursor): number {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    if (c.at >= b.length) throw new MidiParseError("MIDI データが途中で終わっています。");
    const byte = b[c.at++];
    v = (v << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return v;
  }
  throw new MidiParseError("MIDI の可変長数値が壊れています。");
}

type RawEvent =
  | { kind: "on" | "off"; tick: number; channel: number; midi: number; velocity: number }
  | { kind: "program"; tick: number; channel: number; program: number }
  | { kind: "tempo"; tick: number; usPerQuarter: number };

/** 1つの MTrk を舐めてイベントを拾う。解釈しないイベントは長さぶん読み飛ばす。 */
function parseTrack(b: Uint8Array, start: number, end: number, out: RawEvent[]): void {
  const c: Cursor = { at: start };
  let tick = 0;
  /* running status: ステータスバイトが省略されたら直前のものを使う。 */
  let status = 0;

  while (c.at < end) {
    tick += readVarInt(b, c);
    if (c.at >= end) break;
    let byte = b[c.at];
    if (byte & 0x80) {
      status = byte;
      c.at++;
    } else if (!status) {
      throw new MidiParseError("MIDI のイベントが壊れています（ステータスバイトがありません）。");
    }
    byte = status;

    if (byte === 0xff) {
      /* メタイベント */
      const type = b[c.at++];
      const len = readVarInt(b, c);
      if (type === 0x51 && len === 3) {
        out.push({
          kind: "tempo",
          tick,
          usPerQuarter: (b[c.at] << 16) | (b[c.at + 1] << 8) | b[c.at + 2],
        });
      }
      c.at += len;
      /* end of track */
      if (type === 0x2f) return;
      continue;
    }
    if (byte === 0xf0 || byte === 0xf7) {
      /* SysEx はまるごと読み飛ばす。 */
      const len = readVarInt(b, c);
      c.at += len;
      continue;
    }

    const type = byte & 0xf0;
    const channel = byte & 0x0f;
    if (type === 0x80 || type === 0x90) {
      const midi = b[c.at++] & 0x7f;
      const velocity = b[c.at++] & 0x7f;
      /* velocity 0 の note on は note off と同じ意味（よく使われる省略形）。 */
      out.push({
        kind: type === 0x90 && velocity > 0 ? "on" : "off",
        tick,
        channel,
        midi,
        velocity,
      });
    } else if (type === 0xc0) {
      out.push({ kind: "program", tick, channel, program: b[c.at++] & 0x7f });
    } else if (type === 0xd0) {
      c.at += 1;
    } else {
      /* 0xA0 / 0xB0 / 0xE0 はデータ2バイト。 */
      c.at += 2;
    }
  }
}

/** テンポマップ。tick → 秒。テンポチェンジが何回あっても正しく畳む。 */
function makeTickToSec(tempos: { tick: number; usPerQuarter: number }[], tpqn: number) {
  /* 呼び出し側の配列は触らない（ここでコピー済み）。tsconfig は ES2022 なので
     toSorted は使えない。 */
  // oxlint-disable-next-line no-array-sort
  const map = [...tempos].sort((a, b) => a.tick - b.tick);
  if (!map.length || map[0].tick > 0) map.unshift({ tick: 0, usPerQuarter: 500_000 });
  /* 各区間の開始秒を先に積んでおく。 */
  const marks = map.map((m) => ({ ...m, sec: 0 }));
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1];
    marks[i].sec = prev.sec + ((marks[i].tick - prev.tick) * prev.usPerQuarter) / (tpqn * 1e6);
  }
  return (tick: number): number => {
    let i = 0;
    while (i + 1 < marks.length && marks[i + 1].tick <= tick) i++;
    const m = marks[i];
    return m.sec + ((tick - m.tick) * m.usPerQuarter) / (tpqn * 1e6);
  };
}

/**
 * SMF のバイト列をノート列に開く。読めないものは MidiParseError を投げる
 * （「ブラウザが対応していない」ではなく理由の分かる文言にするため）。
 */
export function parseSmf(input: ArrayBuffer | Uint8Array): MidiSong {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 14 || TEXT(b, 0, 4) !== "MThd") {
    throw new MidiParseError("MIDI ファイルとして読めません（MThd ヘッダがありません）。");
  }
  const headLen = u32(b, 4);
  const format = u16(b, 8);
  const division = u16(b, 12);

  if (format === 2) {
    throw new MidiParseError(
      "format 2 の MIDI は対応していません（トラックが独立した曲として並ぶ形式で、1本のタイムラインに並べられません）。",
    );
  }
  if (format !== 0 && format !== 1) {
    throw new MidiParseError(`未知の MIDI format ${format} です（対応は format 0 と 1）。`);
  }
  if (division & 0x8000) {
    throw new MidiParseError(
      "SMPTE タイムコードの MIDI は対応していません（対応は tick/四分音符で刻む形式）。",
    );
  }
  const tpqn = division;
  if (!tpqn) throw new MidiParseError("MIDI の分解能（division）が 0 です。");

  const events: RawEvent[] = [];
  let at = 8 + headLen;
  while (at + 8 <= b.length) {
    const id = TEXT(b, at, 4);
    const len = u32(b, at + 4);
    const start = at + 8;
    const end = Math.min(b.length, start + len);
    if (id === "MTrk") parseTrack(b, start, end, events);
    at = start + len;
  }

  const tickToSec = makeTickToSec(
    events.filter((e): e is Extract<RawEvent, { kind: "tempo" }> => e.kind === "tempo"),
    tpqn,
  );

  /* 同じ tick の中では program → note on の順に効かせたいので、種類でも並べる。 */
  const order = { tempo: 0, program: 1, off: 2, on: 3 } as const;
  events.sort((x, y) => x.tick - y.tick || order[x.kind] - order[y.kind]);

  const program: number[] = Array.from({ length: 16 }, () => 0);
  /* 鳴りっぱなしの音を (channel, midi) ごとに積む。同じ音が重なっても取り違えない。 */
  const open = new Map<number, { tick: number; velocity: number; program: number }[]>();
  const notes: MidiNote[] = [];

  for (const e of events) {
    if (e.kind === "tempo") continue;
    if (e.kind === "program") {
      program[e.channel] = e.program;
      continue;
    }
    const key = e.channel * 128 + e.midi;
    if (e.kind === "on") {
      if (notes.length >= MAX_NOTES) break;
      const stack = open.get(key) ?? [];
      stack.push({ tick: e.tick, velocity: e.velocity, program: program[e.channel] });
      open.set(key, stack);
    } else {
      const stack = open.get(key);
      const started = stack?.pop();
      if (!started) continue;
      const startSec = tickToSec(started.tick);
      notes.push({
        startSec,
        durSec: Math.max(0.01, tickToSec(e.tick) - startSec),
        midi: e.midi,
        velocity: started.velocity,
        channel: e.channel,
        program: started.program,
      });
    }
  }

  /* note off が来ないまま終わった音は、最後のイベント位置で閉じる。 */
  const lastTick = events.length ? events[events.length - 1].tick : 0;
  for (const [key, stack] of open) {
    for (const started of stack) {
      const startSec = tickToSec(started.tick);
      notes.push({
        startSec,
        durSec: Math.max(0.01, tickToSec(lastTick) - startSec),
        midi: key % 128,
        velocity: started.velocity,
        channel: Math.floor(key / 128),
        program: started.program,
      });
    }
  }

  if (!notes.length) {
    throw new MidiParseError("この MIDI にはノートが入っていません（鳴らせる音がありません）。");
  }

  notes.sort((x, y) => x.startSec - y.startSec || x.midi - y.midi);
  return {
    notes,
    durationSec: notes.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0),
    format,
    /* Set から起こした新しい配列なので、その場で並べてよい。 */
    // oxlint-disable-next-line no-array-sort
    channels: [...new Set(notes.map((n) => n.channel))].sort((x, y) => x - y),
  };
}

/** ノート番号 → 周波数（A4 = 69 = 440Hz）。 */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** ドラム（0 始まりのチャンネル 9 ＝ 一般に言うチャンネル10）。段1では鳴らさない。 */
export const DRUM_CHANNEL = 9;
