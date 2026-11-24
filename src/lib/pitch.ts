export type PitchFrame = { time: number; hz: number | null };
export const MAX_PITCH_SECONDS = 8;
export const pitchMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export function noteName(midi: number): string {
  const n = Math.round(midi);
  return ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/** Normalized difference between delayed windows (YIN). Reject weakly periodic frames. */
export function detectPitch(pcm: Float32Array, sampleRate: number): PitchFrame[] {
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const rate = sampleRate / stride;
  const signal = new Float32Array(Math.floor(pcm.length / stride));
  for (let i = 0; i < signal.length; i++) {
    let sum = 0;
    for (let j = 0; j < stride; j++) sum += pcm[i * stride + j];
    signal[i] = sum / stride;
  }
  const maxLag = Math.ceil(rate / 65);
  const minLag = Math.max(2, Math.floor(rate / 1000));
  const window = 2 * maxLag;
  const frameLength = window + maxLag;
  const hop = Math.round(rate * 0.02);
  const diff = new Float64Array(maxLag + 1);
  const frames: PitchFrame[] = [];
  for (let at = 0; at + frameLength <= signal.length; at += hop) {
    const frame: PitchFrame = { time: (at + frameLength / 2) / rate, hz: null };
    frames.push(frame);
    let energy = 0;
    for (let j = 0; j < window; j++) energy += signal[at + j] ** 2;
    if (energy / window < 1e-6) continue;
    let cumulative = 0;
    diff[0] = 1;
    for (let lag = 1; lag <= maxLag; lag++) {
      let error = 0;
      for (let j = 0; j < window; j++) error += (signal[at + j] - signal[at + j + lag]) ** 2;
      cumulative += error;
      diff[lag] = cumulative > 0 ? error * lag / cumulative : 1;
    }
    for (let lag = minLag; lag < maxLag; lag++) {
      if (diff[lag] > 0.12 || diff[lag + 1] < diff[lag]) continue;
      const left = diff[lag - 1], mid = diff[lag], right = diff[lag + 1];
      const denom = 2 * (left + right - 2 * mid);
      const offset = denom > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / denom)) : 0;
      const hz = rate / (lag + offset);
      if (hz >= 65 && hz <= 1000) frame.hz = hz;
      break;
    }
  }
  // A single periodic window in a consonant can look like a low note. Require a
  // voiced neighbour before presenting a pitch; use the original decisions on both sides.
  return frames.map((frame, i) => {
    if (frame.hz === null || frames[i - 1]?.hz || frames[i + 1]?.hz) return frame;
    return { time: frame.time, hz: null };
  });
}
