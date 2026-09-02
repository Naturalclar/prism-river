/**
 * クリップ移動のスナップ計算（#66）。DOM に依存しない純粋関数。
 *
 * スナップ点の収集（他トラックの開始 / 終端、0 秒）は Engine 側の仕事で、
 * ここは「候補のオフセットを、しきい値内で最も近いスナップ点に吸着させる」だけ。
 */

/** しきい値のピクセル数。秒に直すのは呼び出し側（`SNAP_PX / pxPerSec`）。
    ズームインするほど精密になる（DAW の慣習どおり）。 */
export const SNAP_PX = 8;

export type SnapResult = {
  offset: number;
  /** 吸着したスナップ点（秒）。吸着しなかったら null。 */
  snapped: number | null;
};

/**
 * 自分の左端（offset）と右端（offset + duration）の両方を候補にし、
 * しきい値内で最もずれの小さい合わせ方を採る。右端合わせで offset が
 * 負になる組み合わせ（自分より短い位置に終端を合わせる）は捨てる。
 */
export function snapOffset(
  offset: number,
  duration: number,
  targets: readonly number[],
  thresholdSec: number,
): SnapResult {
  type Best = { offset: number; dist: number; point: number };
  let best: Best | null = null;
  const consider = (candidate: number, dist: number, point: number) => {
    if (candidate < 0 || dist > thresholdSec) return;
    if (!best || dist < best.dist) best = { offset: candidate, dist, point };
  };
  for (const p of targets) {
    consider(p, Math.abs(offset - p), p); /* 左端を p に */
    consider(p - duration, Math.abs(offset + duration - p), p); /* 右端を p に */
  }
  /* クロージャ内の代入は TS のフロー解析が追わないので、ここで明示して読む。 */
  const hit = best as Best | null;
  return hit ? { offset: hit.offset, snapped: hit.point } : { offset, snapped: null };
}
