import { computePeaks, type Peaks } from "../lib/peaks";
import { encodeWav } from "../lib/wav";

/* 先頭3色は騒霊三姉妹。弦=ルナサ / 管=メルラン / 鍵盤=リリカ。
   4本目以降は同系統から外して、隣り合うトラックが混ざらないようにする。 */
export const HUE = ["#6E8FD4", "#E8735A", "#A585D6", "#E0A93B", "#63BE8C", "#D66FA0"];

export const LANE_H = 88;
export const CLIP_PAD = 6;

export type Track = {
  id: string;
  name: string;
  buf: AudioBuffer;
  gain: GainNode;
  pan: StereoPannerNode;
  src: AudioBufferSourceNode | null;
  vol: number;
  panv: number;
  mute: boolean;
  solo: boolean;
  offset: number;
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
  duration: number;
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
        duration: t.buf.duration,
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
      this.push(f, buf, ms);
      this.say(
        `${f.name} — ${buf.duration.toFixed(2)}s / ${buf.numberOfChannels}ch / ${buf.sampleRate}Hz / デコード ${ms.toFixed(0)}ms`,
      );
    } catch {
      this.say(`${f.name} をデコードできませんでした（この形式はブラウザが対応していません）`);
    }
  }

  private push(file: File, buf: AudioBuffer, ms: number): void {
    const ctx = this.audio();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.connect(pan);
    if (this.master) pan.connect(this.master);
    const t: Track = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: file.name.replace(/\.[^.]+$/, ""),
      buf,
      gain,
      pan,
      src: null,
      vol: 0.85,
      panv: 0,
      mute: false,
      solo: false,
      offset: 0,
      color: HUE[this.nextHue++ % HUE.length],
      decodeMs: ms,
      peaks: null,
    };
    gain.gain.value = t.vol;
    this.tracks.push(t);
    this.balance();
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

  /** 波形描画用。React には流さず、Clip から直に読む。 */
  peaksFor(id: string, cols: number): Peaks | null {
    const t = this.find(id);
    if (!t) return null;
    if (!t.peaks || t.peaks.cols !== cols) t.peaks = computePeaks(t.buf.getChannelData(0), cols);
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
    if (this.playing) {
      const at = this.now();
      this.halt(true);
      this.seekAt = at;
      this.play();
    }
    this.emit();
  }

  /* ── トランスポート ────────────────────────────────────────────────── */

  total(): number {
    return this.tracks.reduce((m, t) => Math.max(m, t.offset + t.buf.duration), 0);
  }

  now(): number {
    if (!this.playing || !this.ctx) return this.seekAt;
    return Math.min(this.total(), this.seekAt + (this.ctx.currentTime - this.startedAt));
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private stopSrc(t: Track): void {
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
      const local = this.seekAt - t.offset;
      if (local >= t.buf.duration) continue;
      const s = ctx.createBufferSource();
      s.buffer = t.buf;
      s.connect(t.gain);
      if (local >= 0) s.start(at, local);
      else s.start(at - local);
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

  /** L/R の RMS。0〜1。 */
  levels(): [number, number] {
    const a = this.analyser;
    if (!a) return [0, 0];
    return [rms(a.L, a.bL), rms(a.R, a.bR)];
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
        s.connect(g);
        g.connect(p);
        p.connect(mg);
        s.start(t.offset);
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
