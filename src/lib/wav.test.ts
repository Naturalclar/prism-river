import { describe, expect, it } from "vitest";
import { encodeWavBytes, type PcmSource } from "./wav";

function source(channels: Float32Array[], sampleRate = 44100): PcmSource {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (c) => channels[c],
  };
}

const ascii = (v: DataView, o: number, n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(v.getUint8(o + i))).join("");

describe("encodeWavBytes", () => {
  it("writes a 44-byte RIFF/WAVE header", () => {
    const v = new DataView(encodeWavBytes(source([new Float32Array(4), new Float32Array(4)])));
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(34, true)).toBe(16); // 16bit
  });

  it("sizes the buffer as header + frames*channels*2", () => {
    const bytes = encodeWavBytes(source([new Float32Array(100), new Float32Array(100)]));
    expect(bytes.byteLength).toBe(44 + 100 * 2 * 2);
    const v = new DataView(bytes);
    expect(v.getUint32(4, true)).toBe(36 + 400);
    expect(v.getUint32(40, true)).toBe(400);
  });

  it("records channel count, rate and byte rate", () => {
    const v = new DataView(encodeWavBytes(source([new Float32Array(2)], 48000)));
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 1 * 2);
    expect(v.getUint16(32, true)).toBe(2);
  });

  it("interleaves the channels", () => {
    const l = new Float32Array([1, 0]);
    const r = new Float32Array([0, -1]);
    const v = new DataView(encodeWavBytes(source([l, r])));
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(0);
    expect(v.getInt16(48, true)).toBe(0);
    expect(v.getInt16(50, true)).toBe(-0x8000);
  });

  it("clips out-of-range samples instead of wrapping", () => {
    const v = new DataView(encodeWavBytes(source([new Float32Array([4, -4])])));
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });
});
