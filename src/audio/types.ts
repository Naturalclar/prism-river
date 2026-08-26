import type { Peaks } from "../lib/peaks";

/* 先頭3色は騒霊三姉妹。弦=ルナサ / 管=メルラン / 鍵盤=リリカ。
   4本目以降は同系統から外して、隣り合うトラックが混ざらないようにする。 */
export const HUE = ["#6E8FD4", "#E8735A", "#A585D6", "#E0A93B", "#63BE8C", "#D66FA0"];

export const LANE_H = 88;
export const CLIP_PAD = 6;

/** トラックエフェクトのパラメータ。プレーンなデータで、ノードとは分離。 */
export type TrackFx = {
  /** 各バンドのゲイン（dB）。0 で素通し。 */
  eq: { low: number; mid: number; high: number };
  comp: { on: boolean; threshold: number; ratio: number; attack: number; release: number };
};

export const defaultFx = (): TrackFx => ({
  eq: { low: 0, mid: 0, high: 0 },
  comp: { on: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 },
});

export type Track = {
  id: string;
  name: string;
  /** 元ファイル名（拡張子つき）と、その中身。保存（#18）でそのまま書く。 */
  srcName: string;
  srcBytes: Blob;
  buf: AudioBuffer;
  gain: GainNode;
  pan: StereoPannerNode;
  src: AudioBufferSourceNode | null;
  vol: number;
  panv: number;
  mute: boolean;
  solo: boolean;
  offset: number;
  /** バッファ内のトリム範囲（秒）。非破壊で、再生時に範囲指定するだけ。 */
  trimStart: number;
  trimEnd: number;
  /** フェードの長さ（秒、クリップ実効長基準）。0 で無効。 */
  fadeIn: number;
  fadeOut: number;
  /** 再生セッションごとに作るフェード用 GainNode。停止時に外す。 */
  fade: GainNode | null;
  fx: TrackFx;
  /** リアルタイム側の常設エフェクトノード。パラメータはライブで触る。 */
  fxLow: BiquadFilterNode;
  fxMid: BiquadFilterNode;
  fxHigh: BiquadFilterNode;
  fxComp: DynamicsCompressorNode;
  color: string;
  decodeMs: number;
  peaks: Peaks | null;
};

/** React に渡す読み取り専用の姿。AudioNode は含めない。 */
export type TrackView = {
  id: string;
  name: string;
  color: string;
  vol: number;
  panv: number;
  mute: boolean;
  solo: boolean;
  offset: number;
  /** トリム後の実効長（秒）。 */
  duration: number;
  /** バッファ内のトリム開始（秒）。端ドラッグの基準値。 */
  trimStart: number;
  /** フェードの長さ（秒）。 */
  fadeIn: number;
  fadeOut: number;
  fx: TrackFx;
  /** ミュート、または他がソロ中で自分はソロでない。 */
  dimmed: boolean;
  /** クリックで選択中。Delete キーの削除対象。 */
  selected: boolean;
};

export type Telemetry = {
  sampleRate: string;
  latency: string;
  decoded: string;
  ram: string;
  offline: string;
  offlineOk: boolean;
  webm: string;
};

export type Snapshot = {
  tracks: TrackView[];
  pxPerSec: number;
  playing: boolean;
  looping: boolean;
  duration: number;
  masterVol: number;
  /** FX パネルを開いているトラック。無ければ null。 */
  fxId: string | null;
  telemetry: Telemetry;
  message: string;
  hasRender: boolean;
  auditioning: boolean;
  bouncing: boolean;
  recording: boolean;
  /** webm の実時間書き出し中。 */
  webmBusy: boolean;
};

export type Downloads = { save(o: { filename: string; data: Blob }): Promise<void> };

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    claude?: { use(name: "downloads"): Promise<Downloads> };
  }
}
