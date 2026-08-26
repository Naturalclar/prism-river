import { clamp } from "./time";

/**
 * フェードの実効値。トリムでクリップが縮んでも、フェードの合計が
 * 実効長を超えないように詰める（保存値は変えず、掛けるときだけ丸める）。
 */
export function clampFades(eff: number, fadeIn: number, fadeOut: number): { fi: number; fo: number } {
  const fi = clamp(fadeIn, 0, Math.max(0, eff));
  const fo = clamp(fadeOut, 0, Math.max(0, eff - fi));
  return { fi, fo };
}

export type Ramp = { t0: number; v0: number; t1: number; v1: number };

/**
 * 線分 (tA,vA)→(tB,vB) を t=0 以降に切り詰める。AudioParam の
 * setValueAtTime は負の時刻を受け付けないので、過去に始まったランプは
 * t=0 時点の値から張り直す。全部が過去なら null。
 */
export function rampSegment(tA: number, vA: number, tB: number, vB: number): Ramp | null {
  if (tB <= 0) return null;
  let t0 = tA;
  let v0 = vA;
  if (t0 < 0) {
    v0 = vA + ((vB - vA) * (0 - t0)) / (tB - t0);
    t0 = 0;
  }
  return { t0, v0, t1: tB, v1: vB };
}
