/**
 * ループ区間の計算（#88）。DOM にも Engine にも依存しない純粋関数。
 *
 * 区間そのものは「タイムライン上の秒の対」でしかないが、扱いを1か所に
 * 閉じておかないと、ドラッグ・保存の読み込み・トラック削除の3経路が
 * それぞれ別の正規化をしてズレる。
 */

/** これより短い指定は「区間なし」に倒す（秒）。クリップの最短 MIN_CLIP と同じ値。 */
export const MIN_LOOP = 0.05;

export type LoopRange = {
  start: number;
  end: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * ドラッグの2点から区間を組む。左右どちら向きに引いても同じ結果になり、
 * 0〜total に収め、短すぎる指定（＝ほぼクリック）は null にする。
 */
export function makeLoop(a: number, b: number, total: number): LoopRange | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || total <= 0) return null;
  const start = clamp(Math.min(a, b), 0, total);
  const end = clamp(Math.max(a, b), 0, total);
  return end - start < MIN_LOOP ? null : { start, end };
}

/**
 * 既にある区間を今の全長に合わせて読み直す。トラックを消して曲が短くなった
 * ときと、保存データを復元したときに通る。収まらなくなったら null。
 */
export function clampLoop(r: LoopRange | null, total: number): LoopRange | null {
  if (!r) return null;
  return makeLoop(r.start, r.end, total);
}

/**
 * 再生位置 `at` の次の折り返し先。区間があればその頭、無ければ 0 秒。
 * 「終端に達したか」の判定は `loopEnd()` 側。
 */
export function loopStart(r: LoopRange | null): number {
  return r ? r.start : 0;
}

/**
 * ループ再生が折り返す位置。区間が無い（＝全体ループ）なら全長。
 * 区間が全長を超えている場合は全長で切る（消えたクリップの残骸で
 * 到達しない終端を待ち続けないため）。
 */
export function loopEnd(r: LoopRange | null, total: number): number {
  return r ? Math.min(r.end, total) : total;
}
