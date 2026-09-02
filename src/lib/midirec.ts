import { type MidiNote, type MidiSong } from "./midi";

/**
 * MIDI 実機入力（#56）のノート化と保存形式。
 *
 * Web MIDI の `midimessage` から拾ったイベント列を、SMF 解析（midi.ts）と
 * 同じ `MidiNote` に開く。ここまで来れば内蔵シンセの `renderMidi` が
 * 1行も変わらずに鳴らせる。DOM に依存しないので vitest からそのまま叩ける。
 */

/** 受信した1ノートイベント。時刻は録音開始からの相対秒。 */
export type MidiInEvent = {
  atSec: number;
  kind: "on" | "off";
  midi: number;
  velocity: number;
  channel: number;
};

/**
 * Web MIDI の生メッセージ（`MIDIMessageEvent.data`）を解釈する。
 * note on / off 以外（CC・ピッチベンド等）は段1では扱わないので null。
 */
export function parseMidiMessage(data: ArrayLike<number>, atSec: number): MidiInEvent | null {
  if (data.length < 3) return null;
  const type = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const midi = data[1] & 0x7f;
  const velocity = data[2] & 0x7f;
  /* velocity 0 の note on は note off と同じ意味（SMF 解析と同じ扱い）。 */
  if (type === 0x90) return { atSec, kind: velocity > 0 ? "on" : "off", midi, velocity, channel };
  if (type === 0x80) return { atSec, kind: "off", midi, velocity, channel };
  return null;
}

/**
 * イベント列をノート列に閉じる。note off が来ないまま停止した音は
 * `endSec`（録音停止時刻）で閉じる。off だけが来た音は捨てる。
 */
export function notesFromEvents(events: MidiInEvent[], endSec: number): MidiNote[] {
  /* 鳴りっぱなしの音を (channel, midi) ごとに積む。同じ音の重なりも取り違えない
     （SMF 解析と同じ持ち方）。 */
  const open = new Map<number, { atSec: number; velocity: number }[]>();
  const notes: MidiNote[] = [];
  const close = (key: number, started: { atSec: number; velocity: number }, at: number) => {
    notes.push({
      startSec: Math.max(0, started.atSec),
      durSec: Math.max(0.01, at - started.atSec),
      midi: key % 128,
      velocity: Math.max(1, started.velocity),
      channel: Math.floor(key / 128),
      /* 実機入力の段1は音色を選ばない。0（ピアノ系の波形）で鳴らす。 */
      program: 0,
    });
  };

  for (const e of events) {
    const key = e.channel * 128 + e.midi;
    if (e.kind === "on") {
      const stack = open.get(key) ?? [];
      stack.push({ atSec: e.atSec, velocity: e.velocity });
      open.set(key, stack);
    } else {
      const started = open.get(key)?.pop();
      if (started) close(key, started, e.atSec);
    }
  }
  for (const [key, stack] of open) for (const started of stack) close(key, started, endSec);

  notes.sort((x, y) => x.startSec - y.startSec || x.midi - y.midi);
  return notes;
}

/** イベント列を `renderMidi` が食える形にまとめる。ノートが無ければ null。 */
export function songFromEvents(events: MidiInEvent[], endSec: number): MidiSong | null {
  const notes = notesFromEvents(events, endSec);
  if (!notes.length) return null;
  return {
    notes,
    durationSec: notes.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0),
    format: 0,
    /* Set から起こした新しい配列なので、その場で並べてよい。 */
    // oxlint-disable-next-line no-array-sort
    channels: [...new Set(notes.map((n) => n.channel))].sort((x, y) => x - y),
  };
}

/* ── 保存形式（#18） ─────────────────────────────────────────────────────
   実機入力には元ファイルが無いので、ドラム / ピアノロールと同じく
   srcBytes にノート列の JSON を入れる。これが音の正本になる。 */

export const MIDIREC_VERSION = 1;

export function encodeMidiRec(song: MidiSong): string {
  return JSON.stringify({ version: MIDIREC_VERSION, notes: song.notes });
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isNote(v: unknown): v is MidiNote {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    num(n.startSec) &&
    num(n.durSec) &&
    num(n.midi) &&
    num(n.velocity) &&
    num(n.channel) &&
    num(n.program)
  );
}

/** 保存された JSON を検証して開く。壊れていたら null（復元側で「保存なし」に倒す）。 */
export function decodeMidiRec(json: string): MidiSong | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (p.version !== MIDIREC_VERSION) return null;
  if (!Array.isArray(p.notes) || !p.notes.every(isNote) || !p.notes.length) return null;
  const notes = (p.notes as MidiNote[]).map((n) => ({
    startSec: Math.max(0, n.startSec),
    durSec: Math.max(0.01, n.durSec),
    midi: Math.min(127, Math.max(0, Math.round(n.midi))),
    velocity: Math.min(127, Math.max(1, Math.round(n.velocity))),
    channel: Math.min(15, Math.max(0, Math.round(n.channel))),
    program: Math.min(127, Math.max(0, Math.round(n.program))),
  }));
  return {
    notes,
    durationSec: notes.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0),
    format: 0,
    /* 上と同じく自前の新しい配列。 */
    // oxlint-disable-next-line no-array-sort
    channels: [...new Set(notes.map((n) => n.channel))].sort((x, y) => x - y),
  };
}
