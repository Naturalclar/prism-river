import { describe, expect, it } from "vitest";
import { encodeMp3, looksLikeMp3, MP3_KBPS } from "./mp3";

/* WASM（LAME）は Node でもそのまま動くので、エンコード本体を実データで検証できる。 */

function sine(n: number, hz: number, sr: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * hz * i) / sr) * 0.7;
  return a;
}

describe("encodeMp3", () => {
  it("44.1kHz ステレオ 1秒を妥当な MP3 フレーム列にする", async () => {
    const sr = 44100;
    const bytes = await encodeMp3([sine(sr, 440, sr), sine(sr, 330, sr)], sr);
    expect(looksLikeMp3(bytes)).toBe(true);
    /* CBR 192kbps の1秒 ≈ 24KB。エンコーダ遅延と VBR ヘッダで前後する。 */
    const expected = (MP3_KBPS * 1000) / 8;
    expect(bytes.length).toBeGreaterThan(expected * 0.6);
    expect(bytes.length).toBeLessThan(expected * 1.6);
  });

  it("モノラルも通る", async () => {
    const sr = 44100;
    const bytes = await encodeMp3([sine(sr / 2, 440, sr)], sr);
    expect(looksLikeMp3(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("チャンネル無しは例外", async () => {
    await expect(encodeMp3([], 44100)).rejects.toThrow();
  });
});

describe("looksLikeMp3", () => {
  it("ID3v2 タグ・フレーム同期を受け、その他を弾く", () => {
    expect(looksLikeMp3(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(true);
    expect(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
    expect(looksLikeMp3(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false); /* "RIFF" */
    expect(looksLikeMp3(new Uint8Array([0xff]))).toBe(false);
  });
});
