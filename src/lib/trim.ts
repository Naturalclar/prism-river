import { clamp } from "./time";

/** クリップの最短の実効長（秒）。これ以上は詰められない。 */
export const MIN_CLIP = 0.05;

export type ClipSpan = {
  /** タイムライン上の開始位置（秒）。 */
  offset: number;
  /** バッファ内のトリム開始（秒）。 */
  trimStart: number;
  /** バッファ内のトリム終了（秒）。 */
  trimEnd: number;
};

/**
 * 左端のトリム。trimStart を動かした分だけ offset も動かして、
 * 残った波形のタイムライン上の位置を保つ（一般的な DAW の挙動）。
 * 戻す方向は offset が 0 を割る手前で止まる。
 */
export function trimStartTo(span: ClipSpan, sec: number): ClipSpan {
  const lo = Math.max(0, span.trimStart - span.offset);
  const next = clamp(sec, lo, span.trimEnd - MIN_CLIP);
  /* 引き算の丸め誤差で offset がごく僅かに負へ落ちるのを 0 に張り付ける。 */
  const offset = Math.max(0, span.offset + (next - span.trimStart));
  return { ...span, trimStart: next, offset };
}

/** 右端のトリム。バッファ全長 `duration` までしか戻せない。 */
export function trimEndTo(span: ClipSpan, duration: number, sec: number): ClipSpan {
  return { ...span, trimEnd: clamp(sec, span.trimStart + MIN_CLIP, duration) };
}
