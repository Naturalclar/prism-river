import wasmUrl from "rubberband-wasm/dist/rubberband.wasm?url";
import { shiftPhrasePcm } from "../src/lib/stretch";
import { detectPitch, pitchMidi, type PitchFrame } from "../src/lib/pitch";

function medianNote(frames: PitchFrame[]) {
  const notes = frames.flatMap((frame) => frame.hz === null ? [] : [pitchMidi(frame.hz)]);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; notes is a private copy.
  notes.sort((a, b) => a - b);
  return notes.length ? notes[Math.floor(notes.length / 2)] : null;
}

self.addEventListener("message", async ({ data }: MessageEvent<{ pcm: Float32Array; rate: number; midi: number }>) => {
  try {
    const { pcm, rate, midi } = data;
    const start = performance.now();
    const frames = detectPitch(pcm, rate);
    const before = medianNote(frames);
    if (before === null) throw new Error("有声フレームがありません");
    if (Math.abs(before - midi) > 1) throw new Error("目標音に近い単音フレーズを選んでください");
    const cents = Math.max(-25, Math.min(25, (midi - before) * 50));
    const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl));
    const [shifted] = await shiftPhrasePcm(wasm, [pcm], rate, cents);
    // Crossfade only confident frames near the explicit target. Consonants and edges remain dry.
    const width = Math.max(1, Math.round(rate * 0.012));
    let blend = 0, j = 0;
    for (let i = 0; i < shifted.length; i++) {
      const time = i / rate;
      while (j + 1 < frames.length && time >= (frames[j].time + frames[j + 1].time) / 2) j++;
      const frame = frames[j];
      const wet = time >= frames[0].time && time <= frames[frames.length - 1].time &&
        frame.hz !== null && Math.abs(pitchMidi(frame.hz) - midi) < 0.8;
      blend = wet ? Math.min(1, blend + 1 / width) : Math.max(0, blend - 1 / width);
      shifted[i] = pcm[i] + (shifted[i] - pcm[i]) * blend;
    }
    const after = medianNote(detectPitch(shifted, rate));
    const info = { beforeCents: (before - midi) * 100, afterCents: after === null ? null : (after - midi) * 100,
      cents, ms: performance.now() - start, samples: shifted.length, rate };
    self.postMessage({ info, shifted }, { transfer: [shifted.buffer] });
  } catch (e) {
    // oxlint-disable-next-line require-post-message-target-origin
    self.postMessage({ error: String(e) });
  }
});
