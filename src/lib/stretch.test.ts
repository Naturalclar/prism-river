import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isIdentity,
  NO_STRETCH,
  normalizeStretch,
  pitchScale,
  rescaleSeconds,
  stretchPcm,
  stretchedLength,
  timeRatio,
} from "./stretch";

describe("normalizeStretch", () => {
  it("範囲内はそのまま、半音は整数に丸める", () => {
    expect(normalizeStretch({ tempo: 0.75, semitones: 2.4 })).toEqual({ tempo: 0.75, semitones: 2 });
  });

  it("範囲外はクランプする", () => {
    expect(normalizeStretch({ tempo: 0.1, semitones: -30 })).toEqual({
      tempo: 0.5,
      semitones: -12,
    });
    expect(normalizeStretch({ tempo: 9, semitones: 30 })).toEqual({ tempo: 2, semitones: 12 });
  });

  it("壊れた値・欠けた値は等倍に倒す（保存データを読む道なので例外にしない）", () => {
    expect(normalizeStretch(null)).toEqual(NO_STRETCH);
    expect(normalizeStretch({})).toEqual(NO_STRETCH);
    expect(normalizeStretch({ tempo: Number.NaN, semitones: Number.POSITIVE_INFINITY })).toEqual(
      NO_STRETCH,
    );
  });
});

describe("変換の式", () => {
  it("等倍だけが無変化", () => {
    expect(isIdentity(NO_STRETCH)).toBe(true);
    expect(isIdentity({ tempo: 1, semitones: 1 })).toBe(false);
    expect(isIdentity({ tempo: 0.9, semitones: 0 })).toBe(false);
  });

  it("time ratio はテンポの逆数（0.5倍速なら尺は2倍）", () => {
    expect(timeRatio({ tempo: 0.5, semitones: 0 })).toBe(2);
    expect(timeRatio({ tempo: 2, semitones: 0 })).toBe(0.5);
  });

  it("pitch scale は半音 12 で 2倍", () => {
    expect(pitchScale({ tempo: 1, semitones: 12 })).toBeCloseTo(2, 10);
    expect(pitchScale({ tempo: 1, semitones: -12 })).toBeCloseTo(0.5, 10);
    expect(pitchScale(NO_STRETCH)).toBe(1);
  });

  it("処理後の長さはテンポで割った値", () => {
    expect(stretchedLength(44100, { tempo: 0.5, semitones: 0 })).toBe(88200);
    expect(stretchedLength(44100, { tempo: 2, semitones: 0 })).toBe(22050);
    /* ピッチだけ動かしても尺は変わらない。 */
    expect(stretchedLength(44100, { tempo: 1, semitones: 5 })).toBe(44100);
  });
});

describe("rescaleSeconds", () => {
  it("尺の比でトリム位置を伸縮させる", () => {
    /* 2秒の素材の 1.5秒 地点は、4秒に伸ばしたら 3秒 地点。 */
    expect(rescaleSeconds(1.5, 2, 4)).toBe(3);
    expect(rescaleSeconds(1.5, 4, 2)).toBe(0.75);
  });

  it("元の尺が 0 なら触らない（0 除算を作らない）", () => {
    expect(rescaleSeconds(1.5, 0, 4)).toBe(1.5);
  });
});

/* ── WASM 本体（Rubber Band）─────────────────────────────────────────── */

/** Node では wasm を読んで自前で compile する（ブラウザ側は `?url` + compileStreaming）。 */
async function wasm(): Promise<WebAssembly.Module> {
  const bytes = readFileSync("node_modules/rubberband-wasm/dist/rubberband.wasm");
  return WebAssembly.compile(bytes);
}

/** 1秒ぶんのゼロクロス数 ≒ 周波数。ピッチが動いたかを見る一番素朴な物差し。 */
function approxHz(pcm: Float32Array, sampleRate: number, atSample: number): number {
  const seg = pcm.subarray(atSample, atSample + sampleRate);
  let cross = 0;
  for (let i = 1; i < seg.length; i++) if (seg[i - 1] <= 0 && seg[i] > 0) cross++;
  return cross;
}

function tone(hz: number, seconds: number, sampleRate: number): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.7;
  }
  return pcm;
}

describe("stretchPcm（Rubber Band / WASM）", () => {
  const SR = 44100;

  it("0.5倍速で尺が2倍になり、ピッチは変わらない", async () => {
    const input = tone(440, 2, SR);
    const [out] = await stretchPcm(await wasm(), [input], SR, { tempo: 0.5, semitones: 0 });
    expect(out.length).toBe(input.length * 2);
    /* 440Hz のまま（これができないなら playbackRate と変わらない）。 */
    expect(approxHz(out, SR, SR)).toBeGreaterThan(430);
    expect(approxHz(out, SR, SR)).toBeLessThan(450);
  });

  it("ピッチだけ +12半音 上げると尺は変わらず周波数が倍になる", async () => {
    const input = tone(220, 2, SR);
    const [out] = await stretchPcm(await wasm(), [input], SR, { tempo: 1, semitones: 12 });
    expect(out.length).toBe(input.length);
    expect(approxHz(out, SR, SR / 2)).toBeGreaterThan(420);
    expect(approxHz(out, SR, SR / 2)).toBeLessThan(460);
  });

  it("ステレオはチャンネル数を保つ", async () => {
    const l = tone(440, 1, SR);
    const r = tone(660, 1, SR);
    const out = await stretchPcm(await wasm(), [l, r], SR, { tempo: 0.75, semitones: 0 });
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(out[1].length);
    expect(out[0].length).toBe(stretchedLength(l.length, { tempo: 0.75, semitones: 0 }));
  });

  it("入力バッファを書き換えない", async () => {
    const input = tone(440, 0.5, SR);
    const copy = input.slice();
    await stretchPcm(await wasm(), [input], SR, { tempo: 0.5, semitones: 3 });
    expect(input).toEqual(copy);
  });
});
