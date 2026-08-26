export type Peaks = {
  /** 何列分に畳んだか。ズームが変わると作り直す。 */
  cols: number;
  /** 列ごとの最大値（0 以上）。 */
  hi: Float32Array;
  /** 列ごとの最小値（0 以下）。 */
  lo: Float32Array;
};

/**
 * サンプル列を `cols` 本の min/max ペアに畳む。波形描画は1列1pxなので、
 * ここで潰しておけば描画は列数ぶんの矩形で済む。
 */
export function computePeaks(samples: Float32Array, cols: number): Peaks {
  const n = Math.max(1, Math.floor(cols));
  const hi = new Float32Array(n);
  const lo = new Float32Array(n);
  if (samples.length === 0) return { cols: n, hi, lo };

  const per = samples.length / n;
  for (let c = 0; c < n; c++) {
    const start = Math.floor(c * per);
    const end = Math.min(samples.length, Math.floor((c + 1) * per));
    let mn = 0;
    let mx = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v > mx) mx = v;
      else if (v < mn) mn = v;
    }
    hi[c] = mx;
    lo[c] = mn;
  }
  return { cols: n, hi, lo };
}
