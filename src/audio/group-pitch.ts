import { isIdentity, NO_STRETCH, SEMITONE_MAX, SEMITONE_MIN, type StretchParams } from "../lib/stretch";
import { stretchInWorker } from "./stretch";
import type { Track } from "./types";

export type PitchState = { track: Track; buf: AudioBuffer; raw: AudioBuffer; stretch: StretchParams | null };

export async function prepareGroupPitch(ctx: AudioContext, tracks: Track[], ids: string[], delta: number,
  signal: AbortSignal, check: () => void) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("0 以外の整数で半音差を指定してください。");
  const targets = tracks.filter(t => ids.includes(t.id));
  if (!targets.length || targets.length !== ids.length) throw new Error("対象トラックを選び直してください。");
  const requested = targets.map(track => {
    const { tempo, semitones } = track.stretch ?? NO_STRETCH;
    return { track, params: { tempo, semitones: semitones + delta } };
  });
  const invalid = requested.filter(({ params }) => params.semitones < SEMITONE_MIN || params.semitones > SEMITONE_MAX);
  if (invalid.length) throw new Error("±12 半音の範囲外: " + invalid.map(({ track }) => track.name).join("、"));

  const before = targets.map(track => ({ track, buf: track.buf, raw: track.rawBuf, stretch: track.stretch }));
  const after: PitchState[] = [];
  const candidate = tracks.slice();
  // 長尺の素材を複数選んでも、WASM の作業領域は1トラック分に抑える。
  for (const { track, params } of requested) {
    check();
    const raw = track.stretch ? track.rawBuf : track.buf;
    const stretch = isIdentity(params) ? null : params;
    // oxlint-disable-next-line no-await-in-loop
    const buf = stretch ? (await stretchInWorker(ctx, raw, stretch, signal)).buf : raw;
    after.push({ track, buf, raw, stretch });
    candidate[candidate.indexOf(track)] = { ...track, buf };
  }
  return { candidate, before, after };
}
