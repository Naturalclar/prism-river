import type { LoopRange } from "../lib/loop";
import type { BusVols } from "../lib/store";
import { renderMix } from "./bounce";
import type { Track } from "./types";

export const MAX_COMPARE_SECONDS = 12;
export type CompareSide = "A" | "B";

/** Short-window perceptual level estimate. Exclude sub-bass and emphasize upper mids.
 * This is relative level matching for preview, not an integrated LUFS meter. */
async function weightedRms(buffer: AudioBuffer): Promise<number> {
  if (buffer.duration < 0.1) return 0;
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 60;
  hp.Q.value = 0.5;
  const shelf = ctx.createBiquadFilter();
  shelf.type = "highshelf";
  shelf.frequency.value = 1500;
  shelf.gain.value = 4;
  source.connect(hp).connect(shelf).connect(ctx.destination);
  source.start();
  const weighted = await ctx.startRendering();
  let sum = 0;
  for (let ch = 0; ch < weighted.numberOfChannels; ch++) {
    for (const sample of weighted.getChannelData(ch)) sum += sample * sample;
  }
  return Math.sqrt(sum / (weighted.numberOfChannels * weighted.length));
}

export async function prepareComparison(ctx: AudioContext, tracks: Track[], master: number,
  buses: BusVols, selectedId: string, range: LoopRange) {
  const end = Math.min(range.end, range.start + MAX_COMPARE_SECONDS);
  // Include pre-roll for the compressor, EQ and room, even far into a long project.
  const origin = Math.max(0, Math.floor((range.start - 3) * ctx.sampleRate) / ctx.sampleRate);
  const buffers = await Promise.all([selectedId, undefined].map(async (bypass) => {
    const { rendered } = await renderMix(ctx, tracks, master, buses, end, { origin, bypass });
    const start = Math.round(range.start * ctx.sampleRate) - Math.round(origin * ctx.sampleRate);
    const length = Math.round(end * ctx.sampleRate) - Math.round(range.start * ctx.sampleRate);
    const clip = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      clip.getChannelData(ch).set(rendered.getChannelData(ch).subarray(start, start + length));
    }
    return clip;
  }));
  const levels = await Promise.all(buffers.map(weightedRms));
  const target = Math.min(...levels);
  // Attenuation only. Near-silence or too little data leaves both sides untouched.
  const gains = levels.map((level) => target > 0.0001 && Number.isFinite(level) ? target / level : 1);
  return { buffers, gains };
}

export function playComparison(ctx: AudioContext, output: AudioNode,
  prepared: Awaited<ReturnType<typeof prepareComparison>>) {
  const when = ctx.currentTime + 0.025;
  const voices = prepared.buffers.map((buffer, index) => {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = index === 0 ? prepared.gains[0] : 0;
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(output);
    source.start(when);
    return { source, gain };
  });
  return {
    select(side: CompareSide) {
      const now = ctx.currentTime;
      voices.forEach(({ gain }, index) => {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(index === (side === "A" ? 0 : 1) ? prepared.gains[index] : 0, now, 0.004);
      });
    },
    stop() {
      voices.forEach(({ source, gain }) => {
        source.stop();
        source.disconnect();
        gain.disconnect();
      });
    },
  };
}
