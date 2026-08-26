import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWavBytes } from "../src/lib/wav";

const DIR = join(process.cwd(), "test-results", "fixtures");

/**
 * 減衰する正弦波のステレオ WAV を作る。権利のある音源をリポジトリに置かずに
 * 読み込み〜書き出しを通すためのもの。書き出し先は gitignore 済み。
 */
export function makeTone(name: string, hz: number, seconds = 2, sampleRate = 44100): string {
  const n = Math.round(seconds * sampleRate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    /* 0.5秒ごとに減衰を打ち直して、波形に見て分かる起伏を作る。 */
    const env = Math.exp(-6 * (t % 0.5));
    const v = Math.sin(2 * Math.PI * hz * t) * env * 0.7;
    l[i] = v;
    r[i] = v * 0.6;
  }
  const bytes = encodeWavBytes({
    numberOfChannels: 2,
    length: n,
    sampleRate,
    getChannelData: (c) => (c === 0 ? l : r),
  });
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, name);
  writeFileSync(path, new Uint8Array(bytes));
  return path;
}
