/** 秒 → `mm:ss.hh`。負値と NaN は 0 に丸める。 */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  /* 丸めはセンチ秒で1回だけ。秒側を toFixed で丸めると 59.999 が "60.00" に
     繰り上がり、分へ桁上がりせず 00:60.00 になる。 */
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const rest = (cs % 6000) / 100;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** パンの表示ラベル。中央は `C`、それ以外は `L50` / `R50`。 */
export function panLabel(v: number): string {
  if (v === 0) return "C";
  return (v < 0 ? "L" : "R") + String(Math.round(Math.abs(v) * 100));
}

/** ルーラーの目盛り候補（秒）。 */
export const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300] as const;

/** ラベルが 62px 以上離れる最小の刻みを選ぶ。どれも足りなければ 600 秒。 */
export function pickRulerStep(pxPerSec: number): number {
  return RULER_STEPS.find((s) => s * pxPerSec >= 62) ?? 600;
}

/**
 * 刻みが1秒未満のときに小数を落とすと同じラベルが並ぶ（00:00 / 00:00 / 00:01 …）ので、
 * そのときだけ小数第1位を残す。
 */
export function rulerLabel(seconds: number, step: number): string {
  const t = formatTime(seconds);
  return step >= 1 ? t.replace(/\.\d+$/, "") : t.replace(/(\.\d)\d$/, "$1");
}

/** ルーラーの補助目盛りの本数。1秒以上の刻みは4分割、それ未満は2分割。 */
export function rulerSubdivisions(step: number): number {
  return step >= 1 ? 4 : 2;
}
