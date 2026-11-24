import { expect, it } from "vitest";
import { detectPitch, pitchMidi } from "./pitch";

const cents = (t: number) => 32 + 20 * Math.sin(2 * Math.PI * 5 * t);

it("tracks known detuning and vibrato, leaving silence and unvoiced noise blank", () => {
  const sr = 44100;
  const pcm = new Float32Array(sr * 3);
  let phase = 0, seed = 6;
  for (let i = sr; i < sr * 2; i++) {
    phase += 2 * Math.PI * 220 * 2 ** (cents(i / sr) / 1200) / sr;
    pcm[i] = Math.sin(phase) * 0.2;
  }
  for (let i = sr * 2; i < pcm.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pcm[i] = (seed / 2147483648 - 1) * 0.2;
  }
  const frames = detectPitch(pcm, sr);
  const voiced = frames.filter((f) => f.time > 1.05 && f.time < 1.95);
  expect(voiced.length).toBeGreaterThan(40);
  expect(frames.filter((f) => f.time < 0.95 || f.time > 2.05).every((f) => f.hz === null)).toBe(true);
  for (const f of voiced) {
    expect(f.hz).not.toBeNull();
    expect(Math.abs((pitchMidi(f.hz!) - 57) * 100 - cents(f.time))).toBeLessThan(6);
  }
});

it("suppresses a lone periodic frame at the start of a selection", () => {
  const rate = 48000;
  // The window covers about 46 ms. One short periodic burst cannot establish a sung note.
  const pcm = new Float32Array(rate / 4);
  for (let i = 0; i < Math.round(rate * 0.042); i++) pcm[i] = 0.2 * Math.sin(2 * Math.PI * 145 * i / rate);
  expect(detectPitch(pcm, rate).every((f) => f.hz === null)).toBe(true);
});
