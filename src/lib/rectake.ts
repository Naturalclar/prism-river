/**
 * 録音中の仮クリップ（#63）。停止してデコードが終わるまでトラックは現れないので、
 * その間「いま、どこに、鳴っている音が録れているか」を見せるための入れ物。
 *
 * **波形の正確さは狙っていない。** 値は `AnalyserNode` をフレームごとに読んだ
 * ものなので、フレーム間（約16ms）の瞬間的なピークは取りこぼす。正確な波形は
 * 停止後のデコードで `computePeaks()` から出るので、こちらは差し替えて捨てる。
 *
 * DOM に依存しないので vitest からそのまま叩ける（`lib/` の他と同じ方針）。
 */

/** 1列ぶんの時間（秒）。20ms は 60fps の1フレームより粗く、取りこぼしが出にくい。 */
export const TAKE_SLICE = 0.02;

export type RecTake = {
  /** タイムライン上の開始位置（秒）。録り始めた位置で、動かない。 */
  at: number;
  /** ここまでに録れた長さ（秒）。 */
  dur: number;
  /** `TAKE_SLICE` ごとの振幅（0〜1）。長さは容量で、有効なのは dur までぶん。 */
  amp: Float32Array;
};

export function emptyTake(at: number): RecTake {
  /* 4秒ぶんから始めて、足りなくなったら倍にする。 */
  return { at, dur: 0, amp: new Float32Array(Math.ceil(4 / TAKE_SLICE)) };
}

function grown(src: Float32Array, need: number): Float32Array {
  let n = Math.max(1, src.length);
  while (n <= need) n *= 2;
  const next = new Float32Array(n);
  next.set(src);
  return next;
}

/**
 * 経過時間（録り始めからの秒）とそのときの振幅を書き込む。
 *
 * `elapsed` は**オーディオ時計で測った値**を渡すこと。rAF は裏に回ると間引かれる
 * ので、フレーム数で数えると仮クリップだけ尺が縮み、停止後に現れる本物と
 * 食い違う。
 */
export function growTake(take: RecTake, elapsed: number, amp: number): void {
  /* 巻き戻りと停滞は無視（時計の分解能によっては同じ値が続けて来る）。 */
  if (!(elapsed > take.dur)) return;
  const from = Math.floor(take.dur / TAKE_SLICE);
  const to = Math.floor(elapsed / TAKE_SLICE);
  if (to >= take.amp.length) take.amp = grown(take.amp, to);
  /* フレームが飛んだぶんも同じ値で埋める。0 のまま残すと、描画の取りこぼしが
     「無音の隙間」に見えてしまう——無音区間こそがこの表示で一番読ませたい
     情報なので、偽の隙間は出さない。 */
  for (let i = from; i <= to; i++) take.amp[i] = Math.max(take.amp[i], amp);
  take.dur = elapsed;
}

/** 開始からの秒に対応する振幅。範囲外は 0（まだ録れていない＝描かない）。 */
export function takeAmpAt(take: RecTake, sec: number): number {
  if (sec < 0 || sec >= take.dur) return 0;
  return take.amp[Math.floor(sec / TAKE_SLICE)] ?? 0;
}

/**
 * `AnalyserNode.getByteTimeDomainData()` のバイト列からピーク振幅（0〜1）を出す。
 * メーターの `rms()` と違いピークを採るのは、細かい立ち上がりを潰さずに
 * 「音が入っているか」を見せたいため。
 */
export function peakOfBytes(buf: Uint8Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  return peak;
}
