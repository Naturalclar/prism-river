import { createMp3Encoder } from "wasm-media-encoders";

/**
 * MP3 エンコード（#20）。LAME 3.100 の WASM ビルド（wasm-media-encoders）を使う。
 *
 * - ここは DOM に依存しない: Worker（src/audio/mp3worker.ts）からも
 *   vitest（Node）からも同じコードが動く
 * - WASM はシングルスレッド。SharedArrayBuffer もクロスオリジン分離も要らない
 *   （HANDOFF「まずシングルスレッド + WASM SIMD で測る」の通り）
 * - ライセンス: LAME は LGPL、ラッパは MIT。リポジトリは GPL-3.0（#19）なので互換
 */

/** CBR のビットレート。VBR は尺と内容でサイズが読めないので、まず固定にする。 */
export const MP3_KBPS = 192;

/**
 * 一度に encode へ渡すフレーム数（サンプル/ch）。小さく刻むほど WASM 側の
 * 作業バッファが小さく済む。1秒ぶんずつで十分速い。
 */
const CHUNK_FRAMES = 48000;

/**
 * Float32 PCM（1ch または 2ch）を MP3 のバイト列にする。
 * `encode()` の戻り値は次の呼び出しまでしか有効でない（WASM メモリのビュー）
 * ので、その場でコピーして貯める。
 */
export async function encodeMp3(
  channels: readonly Float32Array[],
  sampleRate: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (channels.length < 1) throw new Error("チャンネルがありません");
  const stereo = channels.length >= 2;
  const enc = await createMp3Encoder();
  enc.configure({
    channels: stereo ? 2 : 1,
    sampleRate,
    bitrate: MP3_KBPS,
  });

  const n = channels[0].length;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i += CHUNK_FRAMES) {
    const end = Math.min(n, i + CHUNK_FRAMES);
    const slice = stereo
      ? [channels[0].subarray(i, end), channels[1].subarray(i, end)]
      : [channels[0].subarray(i, end)];
    const out = enc.encode(slice);
    if (out.length) parts.push(out.slice());
  }
  const tail = enc.finalize();
  if (tail.length) parts.push(tail.slice());

  const total = parts.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return bytes;
}

/**
 * 先頭が MP3 として妥当か（ID3v2 タグ、または MPEG フレーム同期）。
 * 書き出し結果の検証用で、厳密なパーサではない。
 */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; /* "ID3" */
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0; /* フレーム同期 11 bits */
}
