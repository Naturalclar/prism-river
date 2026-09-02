import type { Peaks } from "../lib/peaks";
import type { DrumPattern } from "../lib/drums";
import type { RollPattern } from "../lib/pianoroll";
import type { BusId, BusVols } from "../lib/store";

/* 先頭3色は騒霊三姉妹。弦=ルナサ / 管=メルラン / 鍵盤=リリカ。
   4本目以降は同系統から外して、隣り合うトラックが混ざらないようにする。 */
export const HUE = ["#6E8FD4", "#E8735A", "#A585D6", "#E0A93B", "#63BE8C", "#D66FA0"];

export const LANE_H = 110;
export const CLIP_PAD = 6;

/** バスの表示情報。色は HUE の先頭3色＝三姉妹の色をそのまま使う。 */
export const BUS_INFO: Record<BusId, { label: string; sister: string; color: string }> = {
  strings: { label: "弦", sister: "ルナサ", color: HUE[0] },
  winds: { label: "管", sister: "メルラン", color: HUE[1] },
  keys: { label: "鍵盤", sister: "リリカ", color: HUE[2] },
};

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
  /** MIDI 由来なら元のチャンネル、そうでなければ null（#46）。 */
  midiChannel: number | null;
  /** アプリ内で作ったドラムパターン（#54）。生成トラックはこれが音の正本。 */
  drums: DrumPattern | null;
  /** ピアノロールで打ち込んだノート（#55）。同じく生成トラックの正本。 */
  roll: RollPattern | null;
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
  /** 割り当てバス。null は Master 直結（既定）。 */
  bus: BusId | null;
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
  bus: BusId | null;
  fx: TrackFx;
  /** ミュート、または他がソロ中で自分はソロでない。 */
  dimmed: boolean;
  /** クリックで選択中。Delete キーの削除対象。 */
  selected: boolean;
  /** ドラムトラックならそのパターン。格子 UI の表示元（#54）。 */
  drums: DrumPattern | null;
  /** 打ち込みトラックならそのノート列。ピアノロールの表示元（#55）。 */
  roll: RollPattern | null;
};

export type Telemetry = {
  sampleRate: string;
  latency: string;
  decoded: string;
  ram: string;
  offline: string;
  offlineOk: boolean;
  webm: string;
  /** MP3（LAME / WASM）のエンコード時間と倍率。#20 の計測対象。 */
  mp3: string;
  /** MIDI の内蔵シンセレンダー（音数 / ms / 倍率）。#46 の計測対象。 */
  midi: string;
};

export type Snapshot = {
  tracks: TrackView[];
  pxPerSec: number;
  playing: boolean;
  looping: boolean;
  duration: number;
  masterVol: number;
  busVol: BusVols;
  /** FX パネルを開いているトラック。無ければ null。 */
  fxId: string | null;
  /** ドラム格子を開いているトラック。無ければ null（#54）。 */
  drumsId: string | null;
  /** ピアノロールを開いているトラック。無ければ null（#55）。 */
  rollId: string | null;
  telemetry: Telemetry;
  message: string;
  hasRender: boolean;
  auditioning: boolean;
  bouncing: boolean;
  /** WAV / webm / MP3 のどれかが走っている。書き出しは同時に1つだけ（#51）。 */
  exporting: boolean;
  recording: boolean;
  /**
   * 録音中の仮クリップを出しているか（#63）。レーンの出し入れは構造の変化なので
   * React が見るが、**中身（伸びていく幅と振幅）は DOM 直書き**で、ここには来ない。
   * 停止後もデコードが終わるまでは true のまま——本物と差し替わるのがそのとき。
   */
  recTake: boolean;
  /** MIDI 実機入力の録音中（#56）。マイク録音とは独立。 */
  midiRecording: boolean;
  /** webm の実時間書き出し中。 */
  webmBusy: boolean;
  /** MP3（WASM）の書き出し中。 */
  mp3Busy: boolean;
};

export type Downloads = { save(o: { filename: string; data: Blob }): Promise<void> };

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    claude?: { use(name: "downloads"): Promise<Downloads> };
  }
}
