import { clampFades, rampSegment, type Ramp } from "../lib/fade";
import type { TrackFx } from "./types";

/* EQ の固定周波数。まずは3バンドで十分（低棚 / ピーキング / 高棚）。 */
export const EQ_LOW_HZ = 200;
export const EQ_MID_HZ = 1000;
export const EQ_MID_Q = 1.0;
export const EQ_HIGH_HZ = 4000;

export function makeBiquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  gain: number,
): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = freq;
  b.gain.value = gain;
  if (type === "peaking") b.Q.value = EQ_MID_Q;
  return b;
}

/** fx のデータからノード列を組む（bounce のオフライン側用）。素通しなら null。 */
export function buildFxChain(
  ctx: BaseAudioContext,
  fx: TrackFx,
): { input: AudioNode; output: AudioNode } | null {
  const nodes: AudioNode[] = [];
  if (fx.eq.low !== 0 || fx.eq.mid !== 0 || fx.eq.high !== 0) {
    nodes.push(
      makeBiquad(ctx, "lowshelf", EQ_LOW_HZ, fx.eq.low),
      makeBiquad(ctx, "peaking", EQ_MID_HZ, fx.eq.mid),
      makeBiquad(ctx, "highshelf", EQ_HIGH_HZ, fx.eq.high),
    );
  }
  if (fx.comp.on) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = fx.comp.threshold;
    c.ratio.value = fx.comp.ratio;
    c.attack.value = fx.comp.attack;
    c.release.value = fx.comp.release;
    nodes.push(c);
  }
  if (!nodes.length) return null;
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

/** 波形の実効値。メーターの振れ幅にそのまま使う。 */
export function rms(node: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  node.getByteTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / buf.length);
}

/**
 * フェードのランプを AudioParam に張る。`clip0` はクリップ先頭のコンテキスト
 * 時刻で、途中から再生するときは負や過去になり得る（rampSegment が現在値を
 * 保って張り直す）。オンライン・オフラインの両コンテキストで同じに使う。
 */
export function scheduleFades(
  p: AudioParam,
  clip0: number,
  eff: number,
  fadeIn: number,
  fadeOut: number,
): void {
  const { fi, fo } = clampFades(eff, fadeIn, fadeOut);
  const segs: (Ramp | null)[] = [];
  if (fi > 0) segs.push(rampSegment(clip0, 0, clip0 + fi, 1));
  if (fo > 0) segs.push(rampSegment(clip0 + eff - fo, 1, clip0 + eff, 0));
  for (const s of segs) {
    if (!s) continue;
    p.setValueAtTime(s.v0, s.t0);
    p.linearRampToValueAtTime(s.v1, s.t1);
  }
}
