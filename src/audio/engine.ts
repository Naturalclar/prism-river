import { clampFades, rampSegment, type Ramp } from "../lib/fade";
import { computePeaks, type Peaks } from "../lib/peaks";
import { PROJECT_VERSION, type ProjectMeta } from "../lib/store";
import { clamp } from "../lib/time";
import { trimEndTo, trimStartTo } from "../lib/trim";
import { encodeWav } from "../lib/wav";

/* 先頭3色は騒霊三姉妹。弦=ルナサ / 管=メルラン / 鍵盤=リリカ。
   4本目以降は同系統から外して、隣り合うトラックが混ざらないようにする。 */
export const HUE = ["#6E8FD4", "#E8735A", "#A585D6", "#E0A93B", "#63BE8C", "#D66FA0"];

export const LANE_H = 88;
export const CLIP_PAD = 6;

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
};

export type Snapshot = {
  tracks: TrackView[];
  pxPerSec: number;
  playing: boolean;
  looping: boolean;
  duration: number;
  masterVol: number;
  telemetry: Telemetry;
  message: string;
  hasRender: boolean;
  auditioning: boolean;
  bouncing: boolean;
  recording: boolean;
};

type Downloads = { save(o: { filename: string; data: Blob }): Promise<void> };

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    claude?: { use(name: "downloads"): Promise<Downloads> };
  }
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

/** 波形の実効値。メーターの振れ幅にそのまま使う。 */
function rms(node: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  node.getByteTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / buf.length);
}

/**
 * オーディオ側の状態を全部持つ素のクラス。React の外に置いてあるのは意図的で、
 * プレイヘッドとレベルメーターは毎フレーム動くので仮想 DOM を挟まない。
 * 構造が変わったとき（トラックの増減など）だけ `emit()` で React に知らせる。
 */
export class Engine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: {
    L: AnalyserNode;
    R: AnalyserNode;
    bL: Uint8Array<ArrayBuffer>;
    bR: Uint8Array<ArrayBuffer>;
  } | null = null;

  private tracks: Track[] = [];
  /** 録音セッション。マイクのストリームと入力レベル用のアナライザを持つ。 */
  private rec: {
    stream: MediaStream;
    recorder: MediaRecorder;
    chunks: Blob[];
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    buf: Uint8Array<ArrayBuffer>;
  } | null = null;
  private recRaf = 0;
  private recCount = 0;
  private pxPerSec = 70;
  private playing = false;
  private looping = false;
  private seekAt = 0;
  private startedAt = 0;
  private raf = 0;
  private decodeTotal = 0;
  private nextHue = 0;
  private masterVol = 0.9;
  private lastRender: AudioBuffer | null = null;
  private selectedId: string | null = null;
  private auditionSrc: AudioBufferSourceNode | null = null;
  private bouncing = false;
  private message = "音声ファイルを読み込むと計測が始まります。";
  private telemetry: Telemetry = {
    sampleRate: "—",
    latency: "—",
    decoded: "—",
    ram: "—",
    offline: "未実行",
    offlineOk: false,
  };

  private listeners = new Set<() => void>();
  private frameListeners = new Set<() => void>();
  private snap: Snapshot = this.build();

  /* ── 購読 ──────────────────────────────────────────────────────────── */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  /** 毎フレーム呼ばれる購読。プレイヘッド・時計・メーターがこれで動く。 */
  onFrame = (fn: () => void): (() => void) => {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  };

  emitFrame(): void {
    for (const fn of this.frameListeners) fn();
  }

  private emit(): void {
    this.snap = this.build();
    for (const fn of this.listeners) fn();
    /* 時計の全長やプレイヘッドは DOM 直書きなので、構造が変わったらここでも一度描き直す。 */
    this.emitFrame();
  }

  private build(): Snapshot {
    const solo = this.tracks.some((t) => t.solo);
    return {
      tracks: this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        vol: t.vol,
        panv: t.panv,
        mute: t.mute,
        solo: t.solo,
        offset: t.offset,
        duration: t.trimEnd - t.trimStart,
        trimStart: t.trimStart,
        fadeIn: t.fadeIn,
        fadeOut: t.fadeOut,
        dimmed: t.mute || (solo && !t.solo),
        selected: t.id === this.selectedId,
      })),
      pxPerSec: this.pxPerSec,
      playing: this.playing,
      looping: this.looping,
      duration: this.total(),
      masterVol: this.masterVol,
      telemetry: this.telemetry,
      message: this.message,
      hasRender: this.lastRender !== null,
      auditioning: this.auditionSrc !== null,
      bouncing: this.bouncing,
      recording: this.rec !== null,
    };
  }

  private say(m: string): void {
    this.message = m;
    this.emit();
  }

  /* ── グラフ ────────────────────────────────────────────────────────── */

  private audio(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) throw new Error("このブラウザは Web Audio API に対応していません。");
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.masterVol;
    const splitter = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser();
    const aR = ctx.createAnalyser();
    aL.fftSize = 256;
    aR.fftSize = 256;
    master.connect(splitter);
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);
    master.connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
    this.analyser = {
      L: aL,
      R: aR,
      bL: new Uint8Array(aL.fftSize),
      bR: new Uint8Array(aR.fftSize),
    };

    const lat = ctx.outputLatency || ctx.baseLatency;
    this.telemetry = {
      ...this.telemetry,
      sampleRate: `${ctx.sampleRate.toLocaleString()} Hz`,
      latency: lat ? `${(lat * 1000).toFixed(1)} ms` : "非公開",
    };
    return ctx;
  }

  /* ── 読み込み ──────────────────────────────────────────────────────── */

  async ingest(files: ArrayLike<File>): Promise<void> {
    const list = Array.from(files).filter(
      (f) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name),
    );
    if (!list.length) {
      this.say("音声ファイルが見つかりませんでした。");
      return;
    }
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();

    for (const f of list) {
      this.say(`読み込み中: ${f.name} …`);
      /* 1本ずつ順に読む。並列にすると読み込み中のログが混ざるうえ、
         デコード済みの PCM が一度にメモリへ乗る。 */
      // oxlint-disable-next-line no-await-in-loop
      await this.decodeInto(ctx, f);
    }
    this.refreshTelemetry();
    this.emit();
  }

  private async decodeInto(ctx: AudioContext, f: File): Promise<void> {
    try {
      const bytes = await f.arrayBuffer();
      const t0 = performance.now();
      const buf = await ctx.decodeAudioData(bytes);
      const ms = performance.now() - t0;
      this.decodeTotal += ms;
      this.push(f.name.replace(/\.[^.]+$/, ""), f.name, f, buf, ms);
      this.say(
        `${f.name} — ${buf.duration.toFixed(2)}s / ${buf.numberOfChannels}ch / ${buf.sampleRate}Hz / デコード ${ms.toFixed(0)}ms`,
      );
    } catch {
      this.say(`${f.name} をデコードできませんでした（この形式はブラウザが対応していません）`);
    }
  }

  private push(name: string, srcName: string, srcBytes: Blob, buf: AudioBuffer, ms: number): Track {
    const ctx = this.audio();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.connect(pan);
    if (this.master) pan.connect(this.master);
    const t: Track = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name,
      srcName,
      srcBytes,
      buf,
      gain,
      pan,
      src: null,
      vol: 0.85,
      panv: 0,
      mute: false,
      solo: false,
      offset: 0,
      trimStart: 0,
      trimEnd: buf.duration,
      fadeIn: 0,
      fadeOut: 0,
      fade: null,
      color: HUE[this.nextHue++ % HUE.length],
      decodeMs: ms,
      peaks: null,
    };
    gain.gain.value = t.vol;
    this.tracks.push(t);
    this.balance();
    return t;
  }

  /** クリックでの選択。`null` で解除。トグルは呼び出し側が行う。 */
  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  /** Delete キーから。選択が無ければ何もしない。 */
  removeSelected(): void {
    if (this.selectedId) this.remove(this.selectedId);
  }

  remove(id: string): void {
    const t = this.find(id);
    if (!t) return;
    if (this.selectedId === id) this.selectedId = null;
    this.stopSrc(t);
    try {
      t.gain.disconnect();
      t.pan.disconnect();
    } catch {
      /* 既に切れているだけなので無視してよい */
    }
    this.tracks = this.tracks.filter((x) => x !== t);
    if (!this.tracks.length) this.halt();
    this.refreshTelemetry();
    this.balance();
    this.emit();
  }

  private find(id: string): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  /** 波形描画用。React には流さず、Clip から直に読む。トリム範囲だけ畳む。 */
  peaksFor(id: string, cols: number): Peaks | null {
    const t = this.find(id);
    if (!t) return null;
    if (!t.peaks || t.peaks.cols !== cols) {
      const data = t.buf.getChannelData(0);
      const a = Math.floor(t.trimStart * t.buf.sampleRate);
      const b = Math.min(data.length, Math.ceil(t.trimEnd * t.buf.sampleRate));
      t.peaks = computePeaks(data.subarray(a, b), cols);
    }
    return t.peaks;
  }

  private refreshTelemetry(): void {
    const ram = this.tracks.reduce((n, t) => n + t.buf.length * t.buf.numberOfChannels * 4, 0);
    this.telemetry = {
      ...this.telemetry,
      decoded: this.decodeTotal ? `${this.decodeTotal.toFixed(0)} ms` : "—",
      ram: this.tracks.length ? `${(ram / 1048576).toFixed(1)} MB` : "—",
    };
  }

  /* ── プロジェクトの保存・復元（#18） ───────────────────────────────── */

  /**
   * 保存・復元の口（App 側）がログ欄に書くための公開版。Engine 自身は
   * ストレージに触らないので、進捗と結果の表示だけここを通る。
   */
  notify(m: string): void {
    this.say(m);
  }

  /** シリアライズ可能な現在状態。ストレージの都合は呼び出し側（lib/store）に置く。 */
  exportProject(): { meta: ProjectMeta; blobs: Blob[] } | null {
    if (!this.tracks.length) return null;
    return {
      meta: {
        version: PROJECT_VERSION,
        savedAt: Date.now(),
        masterVol: this.masterVol,
        pxPerSec: this.pxPerSec,
        tracks: this.tracks.map((t) => ({
          name: t.name,
          srcName: t.srcName,
          vol: t.vol,
          panv: t.panv,
          mute: t.mute,
          solo: t.solo,
          offset: t.offset,
          trimStart: t.trimStart,
          trimEnd: t.trimEnd,
          fadeIn: t.fadeIn,
          fadeOut: t.fadeOut,
          color: t.color,
        })),
      },
      blobs: this.tracks.map((t) => t.srcBytes),
    };
  }

  /**
   * 保存データからプロジェクトを組み直す。今のトラックは置き換える。
   * 音声は元ファイルのバイト列から通常のデコード経路を通す（＝デコード時間の
   * テレメトリも再計測される）。数値は今の実装の範囲にクランプして読む。
   */
  async importProject(meta: ProjectMeta, blobs: Blob[]): Promise<void> {
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();
    this.halt(true);
    this.seekAt = 0;
    while (this.tracks.length) this.remove(this.tracks[0].id);

    for (let i = 0; i < meta.tracks.length; i++) {
      const m = meta.tracks[i];
      this.say(`復元中: ${m.srcName} …`);
      /* ingest と同じく1本ずつ。並列に読むと PCM が一度にメモリへ乗る。 */
      // oxlint-disable-next-line no-await-in-loop
      const bytes = await blobs[i].arrayBuffer();
      const t0 = performance.now();
      // oxlint-disable-next-line no-await-in-loop
      const buf = await ctx.decodeAudioData(bytes);
      const ms = performance.now() - t0;
      this.decodeTotal += ms;
      const t = this.push(m.name, m.srcName, blobs[i], buf, ms);
      t.vol = clamp(m.vol, 0, 1.4);
      t.panv = clamp(m.panv, -1, 1);
      t.pan.pan.value = t.panv;
      t.mute = m.mute;
      t.solo = m.solo;
      t.offset = Math.max(0, m.offset);
      t.trimEnd = clamp(m.trimEnd, 0, buf.duration);
      t.trimStart = clamp(m.trimStart, 0, t.trimEnd);
      const eff = t.trimEnd - t.trimStart;
      t.fadeIn = clamp(m.fadeIn, 0, eff);
      t.fadeOut = clamp(m.fadeOut, 0, Math.max(0, eff - t.fadeIn));
      t.color = m.color;
    }
    this.nextHue = this.tracks.length;
    this.masterVol = clamp(meta.masterVol, 0, 1.4);
    if (this.master) this.master.gain.value = this.masterVol;
    this.pxPerSec = clamp(meta.pxPerSec, 8, 400);
    this.balance();
    this.refreshTelemetry();
    this.emit();
  }

  /* ── 録音 ──────────────────────────────────────────────────────────── */

  /**
   * 録音ボタンから。開始はユーザー操作起点で呼ぶこと（権限プロンプトの都合）。
   * 録った音声も既存トラックと同じく端末から出ない。
   */
  toggleRecord(): void {
    if (this.rec) {
      /* stop() の完了は recorder の "stop" イベントで受ける。 */
      if (this.rec.recorder.state !== "inactive") this.rec.recorder.stop();
      return;
    }
    void this.startRecording();
  }

  private async startRecording(): Promise<void> {
    if (this.rec) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.say("このブラウザではマイク録音（getUserMedia / MediaRecorder）が使えません。");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.say(
          "マイクの使用が許可されませんでした。ブラウザのサイト設定でマイクを許可してから、もう一度 ● を押してください。",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        this.say("マイクが見つかりませんでした。入力デバイスの接続を確認してください。");
      } else {
        this.say(`マイクを開けませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const ctx = this.audio();
    if (ctx.state === "suspended") void ctx.resume();
    /* 入力レベルの監視用。出力へは繋がない（スピーカーへ返すとハウリングする）。 */
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    /* ボタンからの停止も、デバイス切断などによる予期しない停止もここで受ける。 */
    recorder.addEventListener("stop", () => void this.finishRecording(), { once: true });

    this.rec = { stream, recorder, chunks, source, analyser, buf: new Uint8Array(analyser.fftSize) };
    recorder.start();
    this.recTick();
    this.say("録音中 … もう一度 ● を押すと停止してトラックになります。");
  }

  /** 停止後の後始末とトラック化。Blob 以降は読み込みと同じ decode → push の経路。 */
  private async finishRecording(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    cancelAnimationFrame(this.recRaf);
    for (const trk of rec.stream.getTracks()) trk.stop();
    try {
      rec.source.disconnect();
    } catch {
      /* 既に切れている */
    }

    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" });
    if (!blob.size) {
      this.say("録音データが空でした。マイクの入力レベルを確認してください。");
      return;
    }
    this.say("録音をデコード中 …");
    try {
      const bytes = await blob.arrayBuffer();
      const t0 = performance.now();
      const buf = await this.audio().decodeAudioData(bytes);
      const ms = performance.now() - t0;
      this.decodeTotal += ms;
      const name = `録音 ${++this.recCount}`;
      /* 保存（#18）用に、エンコード済みの録音チャンクを元ファイルとして持たせる。 */
      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
      this.push(name, `${name}.${ext}`, blob, buf, ms);
      this.refreshTelemetry();
      this.say(
        `${name} — ${buf.duration.toFixed(2)}s / ${buf.numberOfChannels}ch / ${buf.sampleRate}Hz / デコード ${ms.toFixed(0)}ms`,
      );
    } catch {
      this.say("録音をデコードできませんでした（この形式はブラウザが対応していません）");
    }
  }

  /** 録音中は再生していなくてもメーターを動かしたいので、専用の rAF を回す。 */
  private recTick = (): void => {
    if (!this.rec) return;
    if (!this.playing) this.emitFrame();
    this.recRaf = requestAnimationFrame(this.recTick);
  };

  /* ── ミキサー ──────────────────────────────────────────────────────── */

  private balance(): void {
    const solo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const on = !t.mute && (!solo || t.solo);
      t.gain.gain.value = on ? t.vol : 0;
    }
  }

  setVol(id: string, v: number): void {
    const t = this.find(id);
    if (!t) return;
    t.vol = v;
    this.balance();
    this.emit();
  }

  setPan(id: string, v: number): void {
    const t = this.find(id);
    if (!t) return;
    t.panv = v;
    t.pan.pan.value = v;
    this.emit();
  }

  toggleSolo(id: string): void {
    const t = this.find(id);
    if (!t) return;
    t.solo = !t.solo;
    this.balance();
    this.emit();
  }

  toggleMute(id: string): void {
    const t = this.find(id);
    if (!t) return;
    t.mute = !t.mute;
    this.balance();
    this.emit();
  }

  setMaster(v: number): void {
    this.masterVol = v;
    if (this.master) this.master.gain.value = v;
    this.emit();
  }

  setPxPerSec(v: number): void {
    this.pxPerSec = v;
    for (const t of this.tracks) t.peaks = null;
    this.emit();
  }

  /* ── クリップの移動 ────────────────────────────────────────────────── */

  /** ドラッグ中に呼ぶ。DOM は呼び出し側が直に動かすので、ここでは再描画しない。 */
  nudgeOffset(id: string, offset: number): void {
    const t = this.find(id);
    if (t) t.offset = Math.max(0, offset);
  }

  /** ドラッグを離したときに呼ぶ。ここで初めて React と再生を組み直す。 */
  commitOffset(id: string): void {
    const t = this.find(id);
    if (!t) return;
    this.say(`${t.name} の開始位置: ${t.offset.toFixed(2)}s`);
    this.rebuildIfPlaying();
    this.emit();
  }

  /* ── トリム ────────────────────────────────────────────────────────── */

  /**
   * 端のドラッグ中に呼ぶ。クランプ後の値を返すので、呼び出し側はそれで
   * DOM を直に動かす（再描画はしない）。左端は offset が連動する。
   */
  trimTo(
    id: string,
    edge: "start" | "end",
    sec: number,
  ): { offset: number; trimStart: number; duration: number } | null {
    const t = this.find(id);
    if (!t) return null;
    const span = { offset: t.offset, trimStart: t.trimStart, trimEnd: t.trimEnd };
    const next = edge === "start" ? trimStartTo(span, sec) : trimEndTo(span, t.buf.duration, sec);
    if (next.trimStart !== t.trimStart || next.trimEnd !== t.trimEnd || next.offset !== t.offset) {
      t.trimStart = next.trimStart;
      t.trimEnd = next.trimEnd;
      t.offset = next.offset;
      t.peaks = null;
    }
    return { offset: t.offset, trimStart: t.trimStart, duration: t.trimEnd - t.trimStart };
  }

  /** トリムのドラッグを離したときに呼ぶ。 */
  commitTrim(id: string): void {
    const t = this.find(id);
    if (!t) return;
    this.say(
      `${t.name} をトリム: 実効 ${(t.trimEnd - t.trimStart).toFixed(2)}s（頭 ${t.trimStart.toFixed(2)}s）`,
    );
    this.rebuildIfPlaying();
    this.emit();
  }

  /* ── フェード ──────────────────────────────────────────────────────── */

  /** フェードハンドルのドラッグ中に呼ぶ。クランプ後の値を返す（DOM 直書き用）。 */
  fadeTo(id: string, edge: "in" | "out", sec: number): { fadeIn: number; fadeOut: number } | null {
    const t = this.find(id);
    if (!t) return null;
    const eff = t.trimEnd - t.trimStart;
    if (edge === "in") t.fadeIn = clamp(sec, 0, Math.max(0, eff - t.fadeOut));
    else t.fadeOut = clamp(sec, 0, Math.max(0, eff - t.fadeIn));
    return { fadeIn: t.fadeIn, fadeOut: t.fadeOut };
  }

  /** フェードのドラッグを離したときに呼ぶ。 */
  commitFade(id: string): void {
    const t = this.find(id);
    if (!t) return;
    this.say(
      `${t.name} のフェード: イン ${t.fadeIn.toFixed(2)}s / アウト ${t.fadeOut.toFixed(2)}s`,
    );
    this.rebuildIfPlaying();
    this.emit();
  }

  /**
   * フェードのランプを AudioParam に張る。`clip0` はクリップ先頭のコンテキスト
   * 時刻で、途中から再生するときは負や過去になり得る（rampSegment が現在値を
   * 保って張り直す）。オンライン・オフラインの両コンテキストで同じに使う。
   */
  private scheduleFades(
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

  /** 再生中にクリップの形が変わったら、位置を保ったままソースを組み直す。 */
  private rebuildIfPlaying(): void {
    if (!this.playing) return;
    const at = this.now();
    this.halt(true);
    this.seekAt = at;
    this.play();
  }

  /* ── トランスポート ────────────────────────────────────────────────── */

  total(): number {
    return this.tracks.reduce((m, t) => Math.max(m, t.offset + (t.trimEnd - t.trimStart)), 0);
  }

  now(): number {
    if (!this.playing || !this.ctx) return this.seekAt;
    return Math.min(this.total(), this.seekAt + (this.ctx.currentTime - this.startedAt));
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private stopSrc(t: Track): void {
    if (t.fade) {
      try {
        t.fade.disconnect();
      } catch {
        /* 既に切れている */
      }
      t.fade = null;
    }
    if (!t.src) return;
    try {
      t.src.stop();
    } catch {
      /* 既に止まっている */
    }
    t.src = null;
  }

  play(): void {
    if (!this.tracks.length) return;
    const ctx = this.audio();
    if (ctx.state === "suspended") void ctx.resume();
    const at = ctx.currentTime + 0.06;
    this.startedAt = at;
    for (const t of this.tracks) {
      this.stopSrc(t);
      const eff = t.trimEnd - t.trimStart;
      const local = this.seekAt - t.offset;
      if (local >= eff) continue;
      const s = ctx.createBufferSource();
      s.buffer = t.buf;
      /* フェードは音量ミキサー（t.gain）とは別の GainNode に張る。 */
      if (t.fadeIn > 0 || t.fadeOut > 0) {
        const f = ctx.createGain();
        this.scheduleFades(f.gain, at - local, eff, t.fadeIn, t.fadeOut);
        s.connect(f);
        f.connect(t.gain);
        t.fade = f;
      } else {
        s.connect(t.gain);
      }
      /* トリムは非破壊なので、start の第2・第3引数でバッファ内の範囲を切る。 */
      if (local >= 0) s.start(at, t.trimStart + local, eff - local);
      else s.start(at - local, t.trimStart, eff);
      t.src = s;
    }
    this.playing = true;
    this.emit();
    this.tick();
  }

  /** `quiet` のときは位置を確定させない（シークやドラッグ中の組み直し用）。 */
  halt(quiet = false): void {
    for (const t of this.tracks) this.stopSrc(t);
    if (this.playing && !quiet) this.seekAt = Math.min(this.total(), this.now());
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
    if (!quiet) this.emitFrame();
  }

  toggle(): void {
    if (this.playing) this.halt();
    else this.play();
  }

  stop(): void {
    this.halt(true);
    this.seekAt = 0;
    this.emitFrame();
  }

  seek(sec: number): void {
    this.seekAt = Math.max(0, Math.min(this.total(), sec));
    if (this.playing) {
      this.halt(true);
      this.play();
    } else {
      this.emitFrame();
    }
  }

  toggleLoop(): void {
    this.looping = !this.looping;
    this.emit();
  }

  private tick = (): void => {
    const t = this.now();
    const dur = this.total();
    this.emitFrame();
    if (dur > 0 && t >= dur - 0.001) {
      if (this.looping) {
        this.seekAt = 0;
        this.halt(true);
        this.play();
        return;
      }
      this.halt();
      this.seekAt = 0;
      this.emitFrame();
      this.say("再生を終了しました。");
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** L/R の RMS。0〜1。録音中はマイクの入力レベルも重ねる（無音録りに気づくため）。 */
  levels(): [number, number] {
    const a = this.analyser;
    const out: [number, number] = a ? [rms(a.L, a.bL), rms(a.R, a.bR)] : [0, 0];
    if (this.rec) {
      const v = rms(this.rec.analyser, this.rec.buf);
      return [Math.max(out[0], v), Math.max(out[1], v)];
    }
    return out;
  }

  /* ── 書き出し ──────────────────────────────────────────────────────── */

  async bounce(): Promise<void> {
    const dur = this.total();
    if (!dur || this.bouncing) return;
    const ctx = this.audio();
    this.bouncing = true;
    this.say("オフラインでミックスを描画中 …");

    /* 失敗しても bouncing を必ず戻す。長尺では encodeWav のメモリ確保が
       落ちることが現実にあり、ここで戻さないと書き出しボタンが死んだままになる。 */
    try {
      const t0 = performance.now();
      const sr = ctx.sampleRate;
      const off = new OfflineAudioContext(2, Math.ceil(dur * sr) + sr * 0.1, sr);
      const mg = off.createGain();
      mg.gain.value = this.masterVol;
      mg.connect(off.destination);
      const solo = this.tracks.some((t) => t.solo);
      for (const t of this.tracks) {
        if (t.mute || (solo && !t.solo)) continue;
        const g = off.createGain();
        const p = off.createStereoPanner();
        const s = off.createBufferSource();
        g.gain.value = t.vol;
        p.pan.value = t.panv;
        s.buffer = t.buf;
        const eff = t.trimEnd - t.trimStart;
        if (t.fadeIn > 0 || t.fadeOut > 0) {
          const f = off.createGain();
          this.scheduleFades(f.gain, t.offset, eff, t.fadeIn, t.fadeOut);
          s.connect(f);
          f.connect(g);
        } else {
          s.connect(g);
        }
        g.connect(p);
        p.connect(mg);
        s.start(t.offset, t.trimStart, eff);
      }
      const rendered = await off.startRendering();
      const ms = performance.now() - t0;
      this.telemetry = { ...this.telemetry, offline: `${ms.toFixed(0)} ms`, offlineOk: true };
      this.lastRender = rendered;

      const wav = encodeWav(rendered);
      const rt = (dur / (ms / 1000)).toFixed(0);
      const size = (wav.size / 1048576).toFixed(1);
      this.say(
        `レンダー完了: ${dur.toFixed(2)}s / ${size}MB / 実時間の約${rt}倍速。保存を試みています …`,
      );

      await this.deliver(wav, rt, size);
    } catch (err) {
      this.say(`書き出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.bouncing = false;
      this.emit();
    }
  }

  /**
   * claude.ai のビューア内でだけ `window.claude` が生える。自分のドメインに
   * 置いたときは存在しないので、その場合は通常のダウンロードに落とす。
   */
  private async deliver(wav: Blob, rt: string, size: string): Promise<void> {
    if (!window.claude) {
      const url = URL.createObjectURL(wav);
      const a = document.createElement("a");
      a.href = url;
      a.download = "prism-river-mix.wav";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      this.say(`書き出しました: ${size}MB / 実時間の約${rt}倍速。`);
      return;
    }
    /* capability の取得自体が reject することがある（無効化されている等）。 */
    let dl: Downloads | null = null;
    try {
      dl = await window.claude.use("downloads");
    } catch {
      dl = null;
    }
    if (!dl) {
      this.say(
        `レンダー完了（${rt}倍速, ${size}MB）。このビューではファイル保存が使えないので、試聴のみ可能です。`,
      );
      return;
    }
    try {
      await dl.save({ filename: "prism-river-mix.wav", data: wav });
      this.say(`保存しました。レンダーは実時間の約${rt}倍速（${size}MB）。`);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "rejected_extension" || code === "extension_not_enabled") {
        this.say(
          `レンダーは成功（${rt}倍速, ${size}MB）。ただし .wav はこのビューアの保存許可リストに無いため書き出せません — ブラウザの制限ではなく claude.ai 側の制限なので、自分のドメインに置けば普通に保存できます。ここでは「レンダーを試聴」で結果を確認してください。`,
        );
      } else if (code === "too_large") {
        this.say(
          `レンダーは成功したが ${size}MB は保存上限(16MiB)超え。尺を削るか、自分のドメインで動かしてください。`,
        );
      } else if (code === "declined") {
        this.say("保存はキャンセルされました。レンダー結果は「レンダーを試聴」で確認できます。");
      } else {
        this.say(`レンダーは成功（${rt}倍速）。保存は失敗しました: ${code ?? "不明なエラー"}`);
      }
    }
  }

  audition(): void {
    if (!this.lastRender || !this.ctx || !this.master) return;
    if (this.auditionSrc) {
      try {
        this.auditionSrc.stop();
      } catch {
        /* 既に終わっている */
      }
      this.auditionSrc = null;
      this.emit();
      return;
    }
    this.halt(true);
    const s = this.ctx.createBufferSource();
    s.buffer = this.lastRender;
    s.connect(this.master);
    s.start();
    s.addEventListener(
      "ended",
      () => {
        this.auditionSrc = null;
        this.emit();
      },
      { once: true },
    );
    this.auditionSrc = s;
    this.say(
      `レンダー結果を再生中（${this.lastRender.duration.toFixed(2)}s / ${this.lastRender.numberOfChannels}ch）。`,
    );
  }
}
