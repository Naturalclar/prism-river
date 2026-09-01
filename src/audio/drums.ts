import { expandPattern, patternDuration, type DrumPattern, type DrumVoice } from "../lib/drums";

/**
 * ドラムパターンを内蔵音源でオフラインレンダーする（#54）。
 *
 * サンプルは同梱しない（制約「権利のあるファイルをコミットしない」）ので、
 * 全部その場で合成する。依存ゼロで、HANDOFF の「WASM の領分」表にも当たらない
 * ——キックもスネアもハットも、正弦波・ノイズ・フィルタと折れ線エンベロープで
 * 出せる範囲。AudioBuffer にしてしまえば以降はトリム・フェード・FX・バス・
 * 書き出し・保存がそのまま効く（MIDI #46 と同じ乗せ方）。
 *
 * 音色の作り込みは範囲外で、狙いは「それらしく鳴る」までとする。
 */

/** 音色ごとの長さ（秒）。バッファの末尾に足す余白の計算に使う。 */
const TAIL: Record<DrumVoice, number> = {
  kick: 0.3,
  snare: 0.2,
  hatClosed: 0.06,
  hatOpen: 0.35,
};

/** 音色ごとの音量。合計してもクリップしないように抑えめに取る。 */
const LEVEL: Record<DrumVoice, number> = {
  kick: 0.9,
  snare: 0.6,
  hatClosed: 0.28,
  hatOpen: 0.24,
};

/** ホワイトノイズ。スネアとハットの素材で、1本を全発音で使い回す。 */
function noiseBuffer(ctx: OfflineAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** 直線の折れ線だけで減衰を書く（MIDI 側と同じ理由: 予約値だけで音が決まる）。 */
function decay(gain: AudioParam, at: number, level: number, seconds: number): void {
  gain.setValueAtTime(0, at);
  /* 立ち上がりを 0 にしないのは、ステップの頭でプツッと鳴らないため。 */
  gain.linearRampToValueAtTime(level, at + 0.002);
  gain.linearRampToValueAtTime(0, at + seconds);
}

function kick(ctx: OfflineAudioContext, dest: AudioNode, at: number): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  /* 150Hz から 50Hz へ急降下させるのがバスドラらしさの正体。 */
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(50, at + 0.08);
  decay(g.gain, at, LEVEL.kick, TAIL.kick);
  osc.connect(g);
  g.connect(dest);
  osc.start(at);
  osc.stop(at + TAIL.kick + 0.01);
}

function snare(ctx: OfflineAudioContext, dest: AudioNode, noise: AudioBuffer, at: number): void {
  /* ノイズ（スナッピー）＋ 胴の鳴りの三角波を重ねる。 */
  const src = ctx.createBufferSource();
  const bp = ctx.createBiquadFilter();
  const ng = ctx.createGain();
  src.buffer = noise;
  bp.type = "bandpass";
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;
  decay(ng.gain, at, LEVEL.snare, TAIL.snare);
  src.connect(bp);
  bp.connect(ng);
  ng.connect(dest);
  src.start(at);
  src.stop(at + TAIL.snare + 0.01);

  const osc = ctx.createOscillator();
  const og = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 180;
  decay(og.gain, at, LEVEL.snare * 0.5, TAIL.snare * 0.6);
  osc.connect(og);
  og.connect(dest);
  osc.start(at);
  osc.stop(at + TAIL.snare + 0.01);
}

function hat(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  noise: AudioBuffer,
  at: number,
  open: boolean,
): void {
  const src = ctx.createBufferSource();
  const hp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  src.buffer = noise;
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const voice: DrumVoice = open ? "hatOpen" : "hatClosed";
  decay(g.gain, at, LEVEL[voice], TAIL[voice]);
  src.connect(hp);
  hp.connect(g);
  g.connect(dest);
  src.start(at);
  src.stop(at + TAIL[voice] + 0.01);
}

export type DrumRenderResult = { buf: AudioBuffer; ms: number; hits: number };

/** パターンを鳴らして AudioBuffer にする。長さはパターンの全長ちょうど。 */
export async function renderDrums(
  pattern: DrumPattern,
  sampleRate: number,
): Promise<DrumRenderResult> {
  const t0 = performance.now();
  const hits = expandPattern(pattern);
  /* 最後の発音の減衰がループの尻で切れないよう、余白を足してから全長で切る。
     全長をパターンちょうどにしておくと、2本並べたときに拍が合う。 */
  const dur = patternDuration(pattern);
  const pad = Math.max(...Object.values(TAIL));
  const off = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil((dur + pad) * sampleRate)),
    sampleRate,
  );
  const master = off.createGain();
  master.gain.value = 0.8;
  master.connect(off.destination);
  const noise = noiseBuffer(off);

  for (const h of hits) {
    if (h.voice === "kick") kick(off, master, h.atSec);
    else if (h.voice === "snare") snare(off, master, noise, h.atSec);
    else hat(off, master, noise, h.atSec, h.voice === "hatOpen");
  }

  const rendered = await off.startRendering();
  /* 余白ぶんを落として、クリップの長さをパターンの全長に揃える。 */
  const frames = Math.max(1, Math.ceil(dur * sampleRate));
  const buf = new OfflineAudioContext(2, frames, sampleRate).createBuffer(2, frames, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    buf.copyToChannel(rendered.getChannelData(ch).subarray(0, frames), ch);
  }
  return { buf, ms: performance.now() - t0, hits: hits.length };
}
