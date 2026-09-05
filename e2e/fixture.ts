import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMp3Encoder, createOggEncoder } from "wasm-media-encoders";
import { encodeWavBytes } from "../src/lib/wav";

/**
 * 生成物の置き場。**外へは出さない**（#90）。ここへ直に書く経路を作ると、
 * 同じ名前を別のテストが同時に書く事故が戻ってくるので、書き込みは
 * すべて `put()` に通す。
 */
const FIXTURE_DIR = join(process.cwd(), "test-results", "fixtures");

/** 減衰する正弦波のステレオ PCM。0.5秒ごとに打ち直して波形に起伏を作る。 */
function toneSamples(hz: number, seconds: number, sampleRate: number): [Float32Array, Float32Array] {
  const n = Math.round(seconds * sampleRate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-6 * (t % 0.5));
    const v = Math.sin(2 * Math.PI * hz * t) * env * 0.7;
    l[i] = v;
    r[i] = v * 0.6;
  }
  return [l, r];
}

let tmpSeq = 0;

/**
 * 生成物を `<中身のハッシュ>/<名前>` に置く（#90）。
 *
 * 以前は共有ディレクトリに名前そのままで書いていたので、**同じ名前で違う
 * 中身**を要求する2つのテスト（`fullyParallel` なので同時に走る）が同じパスを
 * 奪い合い、書きかけの WAV を読んだ側の `decodeAudioData` が落ちて
 * 「トラックが1本足りない」という、退行と見分けのつかない失敗になっていた。
 *
 * 中身でパスを分けると、違う中身は絶対に衝突せず、同じ中身は1つを共有する。
 * 名前（basename）は変えない——トラック名は取り込んだファイル名から作るので、
 * 変えると各 spec の表示検証まで書き換えになる。
 *
 * 書き込みは一時ファイル → `rename`（同一 FS なので原子的）。同じ中身を2つの
 * ワーカーが同時に要求しても、読み手からは「無い」か「完全な1つ」しか見えない。
 */
function put(name: string, bytes: Uint8Array): string {
  const dir = join(FIXTURE_DIR, createHash("sha1").update(bytes).digest("hex").slice(0, 12));
  const path = join(dir, name);
  /* 中身がパスを決めているので、在ればそれが求めているもの。書き直さない。 */
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  return path;
}

/**
 * 既にあるファイル（書き出しのダウンロード等）を同じ規則で置き直す。
 * `put()` を通すので、これも並列に走って安全。
 */
export function putCopy(name: string, srcPath: string): string {
  return put(name, readFileSync(srcPath));
}

/**
 * 減衰する正弦波のステレオ WAV を作る。権利のある音源をリポジトリに置かずに
 * 読み込み〜書き出しを通すためのもの。書き出し先は gitignore 済み。
 */
export function makeTone(name: string, hz: number, seconds = 2, sampleRate = 44100): string {
  const [l, r] = toneSamples(hz, seconds, sampleRate);
  const bytes = encodeWavBytes({
    numberOfChannels: 2,
    length: l.length,
    sampleRate,
    getChannelData: (c) => (c === 0 ? l : r),
  });
  return put(name, new Uint8Array(bytes));
}

/** 同じトーンの MP3 版（LAME / wasm-media-encoders。Node でそのまま動く）。#22 の形式検証用。 */
export async function makeToneMp3(
  name: string,
  hz: number,
  seconds = 2,
  sampleRate = 44100,
): Promise<string> {
  const [l, r] = toneSamples(hz, seconds, sampleRate);
  const enc = await createMp3Encoder();
  enc.configure({ channels: 2, sampleRate, bitrate: 128 });
  const head = enc.encode([l, r]).slice();
  const tail = enc.finalize().slice();
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head, 0);
  bytes.set(tail, head.length);
  return put(name, bytes);
}

/** 同じトーンの Ogg Vorbis 版。#22 の形式検証用。 */
export async function makeToneOgg(
  name: string,
  hz: number,
  seconds = 2,
  sampleRate = 44100,
): Promise<string> {
  const [l, r] = toneSamples(hz, seconds, sampleRate);
  const enc = await createOggEncoder();
  enc.configure({ channels: 2, sampleRate, vbrQuality: 3 });
  const head = enc.encode([l, r]).slice();
  const tail = enc.finalize().slice();
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head, 0);
  bytes.set(tail, head.length);
  return put(name, bytes);
}

/** どのデコーダも受けないゴミバイト列。エラー表示の検証用。 */
export function makeGarbage(name: string, size = 4096): string {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) % 251;
  return put(name, bytes);
}

/* ── MIDI（#46）─────────────────────────────────────────────────────── */

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

/**
 * 単純な SMF を書く。既定テンポ（120BPM・480tpqn）で、note ごとに
 * `[開始拍, 長さ拍, ノート番号]` を与える。権利のある MIDI を置かないため。
 */
export function makeMidi(
  name: string,
  notes: { atBeat: number; beats: number; midi: number; channel?: number }[],
  format = 0,
): string {
  const TPQN = 480;
  /* 絶対 tick のイベント列に開いてから、デルタに直す。 */
  const events: { tick: number; bytes: number[] }[] = [];
  for (const n of notes) {
    const ch = n.channel ?? 0;
    events.push({ tick: Math.round(n.atBeat * TPQN), bytes: [0x90 | ch, n.midi, 100] });
    events.push({
      tick: Math.round((n.atBeat + n.beats) * TPQN),
      bytes: [0x80 | ch, n.midi, 0],
    });
  }
  events.sort((a, b) => a.tick - b.tick);
  let prev = 0;
  const body: number[] = [];
  for (const e of events) {
    body.push(...varInt(e.tick - prev), ...e.bytes);
    prev = e.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);

  const bytes = new Uint8Array([
    ...chunk("MThd", [0, format, 0, 1, (TPQN >> 8) & 0xff, TPQN & 0xff]),
    ...chunk("MTrk", body),
  ]);
  return put(name, bytes);
}

/** format 2（対応外）の SMF。理由の分かるエラーが出ることの確認用。 */
export function makeUnsupportedMidi(name: string): string {
  const body = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00];
  const bytes = new Uint8Array([
    ...chunk("MThd", [0, 2, 0, 1, 0x01, 0xe0]),
    ...chunk("MTrk", body),
  ]);
  return put(name, bytes);
}
