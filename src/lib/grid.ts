/**
 * 格子（ステップ）とテンポの共通部分。
 *
 * ドラムの格子（#54）とピアノロール（#55）で同じ刻みと同じ BPM の範囲を使う。
 * 2つの格子 UI が別々の時間軸を持つと、並べたときに拍が合わなくなる。
 *
 * ⚠️ プロジェクト全体のテンポはまだ無い。各トラックが自分の BPM を持つ段階で、
 * 全体のテンポとスナップは別の話（#54 / #55 の「範囲外」参照）。
 */

/** 1小節あたりのステップ数。16分音符なので 4拍 × 4。 */
export const STEPS = 16;

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const BARS_MIN = 1;
export const BARS_MAX = 4;

export const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const clampBpm = (bpm: number) => clampNum(bpm, BPM_MIN, BPM_MAX);

/** 1ステップ（16分音符）の長さ（秒）。120BPM なら 0.125s。 */
export function stepSec(bpm: number): number {
  return 60 / clampNum(bpm, BPM_MIN, BPM_MAX) / (STEPS / 4);
}

/** `bars 小節 × 4拍` の長さ（秒）。クリップの尺はこれちょうどにする。 */
export function barsDuration(bpm: number, bars: number): number {
  return stepSec(bpm) * STEPS * clampNum(bars, BARS_MIN, BARS_MAX);
}
