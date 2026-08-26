import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMp3Encoder, createOggEncoder } from "wasm-media-encoders";
import { encodeWavBytes } from "../src/lib/wav";

export const FIXTURE_DIR = join(process.cwd(), "test-results", "fixtures");

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

function put(name: string, bytes: Uint8Array): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, name);
  writeFileSync(path, bytes);
  return path;
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
