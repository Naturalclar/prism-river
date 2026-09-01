import { encodeMp3InWorker } from "./mp3";
import {
  decodeDrumPattern,
  emptyPattern,
  encodeDrumPattern,
  presetHits,
  type DrumPattern,
  type DrumVoice,
  type PresetId,
} from "../lib/drums";
import { DRUM_CHANNEL, MidiParseError, parseSmf, type MidiSong } from "../lib/midi";
import { MP3_KBPS } from "../lib/mp3";
import { computePeaks, type Peaks } from "../lib/peaks";
import { BUS_IDS, type BusId, type BusVols, type ProjectMeta } from "../lib/store";
import { clamp } from "../lib/time";
import { trimEndTo, trimStartTo } from "../lib/trim";
import { encodeWav } from "../lib/wav";
import { deliverBlob, deliverWav, recordToWebm, renderMix, webmSupported } from "./bounce";
import { EQ_HIGH_HZ, EQ_LOW_HZ, EQ_MID_HZ, makeBiquad, rms, scheduleFades } from "./graph";
import { renderDrums } from "./drums";
import { renderMidi } from "./midi";
import { projectMetaOf } from "./project";
import { collectRecording, openMic, type RecSession } from "./recorder";
import {
  BUS_INFO,
  defaultFx,
  HUE,
  type Snapshot,
  type Telemetry,
  type Track,
  type TrackFx,
} from "./types";

/* 型と定数は types.ts が正本。コンポーネントは従来どおりここから import できる。 */
export { BUS_INFO, CLIP_PAD, HUE, LANE_H } from "./types";
export { BUS_IDS, type BusId } from "../lib/store";
export type { Snapshot, Telemetry, Track, TrackFx, TrackView } from "./types";

/* 拡張子は入口の粗い篩。実際に読めるかは decodeAudioData（ブラウザ依存）が決める。
   opus / oga / webm / weba も通す — 自前の webm 書き出しを読み戻せるように（#22）。 */
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm|weba)$/i;
/* 動画コンテナも受け入れる（#31）。decodeAudioData はバイト列から音声トラック
   だけをデコードできる場合がある（ブラウザとコンテナ依存）ので、入口では
   弾かずに既存のデコード経路へ流し、ダメなら動画由来と分かる文言で伝える。
   webm は音声にも動画にも使われるので、拡張子では動画扱いしない。 */
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv)$/i;

/* MIDI は音声ではなく音符イベントなので、decodeAudioData では永久に読めない（#46）。
   拡張子から audio/midi が付いて入口を通ってしまうため、ここで先に振り分けて
   SMF 解析＋内蔵シンセのレンダー経路へ送る。 */
const MIDI_EXT = /\.(mid|midi|smf)$/i;

/* アプリ内で作ったドラムトラックの目印（#54）。元ファイルが無いので、
   srcBytes にはパターンの JSON を入れてある。復元はここで振り分ける。 */
const DRUMS_EXT = /\.drums\.json$/i;

function isDrumsFile(f: { name: string }): boolean {
  return DRUMS_EXT.test(f.name);
}

/** エラー文言の分岐用。音声の取り込みか、動画からの音声取り出しか。 */
function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
}

function isMidiFile(f: { name: string; type?: string }): boolean {
  return /^audio\/(x-)?midi$/.test(f.type ?? "") || MIDI_EXT.test(f.name);
}

/** GM のチャンネル番号（0 始まり）を人が読む名前にする。 */
function channelLabel(channel: number): string {
  return channel === DRUM_CHANNEL ? "ドラム" : `ch${channel + 1}`;
}

/**
 * オーディオ側の状態を全部持つ素のクラス。React の外に置いてあるのは意図的で、
 * プレイヘッドとレベルメーターは毎フレーム動くので仮想 DOM を挟まない。
 * 構造が変わったとき（トラックの増減など）だけ `emit()` で React に知らせる。
 */
export class Engine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** グループバス。トラックは pan → busGain → master。作成は audio() で。 */
  private busGain: Record<BusId, GainNode> | null = null;
  private busVol: BusVols = { strings: 1, winds: 1, keys: 1 };
  private analyser: {
    L: AnalyserNode;
    R: AnalyserNode;
    bL: Uint8Array<ArrayBuffer>;
    bR: Uint8Array<ArrayBuffer>;
  } | null = null;

  private tracks: Track[] = [];
  /** 録音セッション。マイクのストリームと入力レベル用のアナライザを持つ。 */
  private rec: RecSession | null = null;
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
  private fxId: string | null = null;
  private drumsId: string | null = null;
  private drumCount = 0;
  /** ドラムの再レンダーは非同期なので、古い結果で上書きしないための世代。 */
  private drumGen = 0;
  private auditionSrc: AudioBufferSourceNode | null = null;
  private bouncing = false;
  private webmBusy = false;
  private mp3Busy = false;
  private message = "音声ファイルを読み込むと計測が始まります。";
  private telemetry: Telemetry = {
    sampleRate: "—",
    latency: "—",
    decoded: "—",
    ram: "—",
    offline: "未実行",
    webm: "未実行",
    mp3: "未実行",
    midi: "未実行",
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
        bus: t.bus,
        fx: { eq: { ...t.fx.eq }, comp: { ...t.fx.comp } },
        dimmed: t.mute || (solo && !t.solo),
        selected: t.id === this.selectedId,
        drums: t.drums ? { ...t.drums, hits: { ...t.drums.hits } } : null,
      })),
      pxPerSec: this.pxPerSec,
      playing: this.playing,
      looping: this.looping,
      duration: this.total(),
      masterVol: this.masterVol,
      busVol: { ...this.busVol },
      fxId: this.fxId,
      drumsId: this.drumsId,
      telemetry: this.telemetry,
      message: this.message,
      hasRender: this.lastRender !== null,
      auditioning: this.auditionSrc !== null,
      bouncing: this.bouncing,
      exporting: this.exporting,
      recording: this.rec !== null,
      webmBusy: this.webmBusy,
      mp3Busy: this.mp3Busy,
    };
  }

  private say(m: string): void {
    this.message = m;
    this.emit();
  }

  /**
   * 音に効く変更のあとはこれで締める（#49）。表示だけの変更（選択・ズーム・
   * FX パネルの開閉・トランスポート）は `emit()` のままでよい。
   *
   * オーディオの機能を足すときは、その setter がどちらで終わるかを見ること。
   * `emit()` で済ませるとレンダー結果が古いまま残り、「レンダーを試聴」が
   * 編集前のミックスを鳴らす——例外も無音も出ないので気づけない類になる。
   */
  private touched(): void {
    this.invalidateRender();
    this.emit();
  }

  /**
   * レンダー結果を捨てる。試聴中ならそれも止める。作り直しはしない
   * （レンダーは尺に比例するので、押されたときだけでよい）。
   */
  private invalidateRender(): void {
    if (!this.lastRender) return;
    this.lastRender = null;
    this.stopAudition();
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

    /* グループバス3系統。将来のバスエフェクト（#12 と同型）は
       busGain と master の間に挿す。 */
    const busGain = {} as Record<BusId, GainNode>;
    for (const b of BUS_IDS) {
      const g = ctx.createGain();
      g.gain.value = this.busVol[b];
      g.connect(master);
      busGain[b] = g;
    }
    this.busGain = busGain;

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
    const all = Array.from(files);
    const list = all.filter(
      (f) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name) || isVideoFile(f) || isMidiFile(f),
    );
    /* 対応外は黙って落とさず、名前を挙げて伝える（#22）。 */
    const skipped = all.filter((f) => !list.includes(f));
    if (!list.length) {
      this.say(
        skipped.length
          ? `対応外のファイルのみでした: ${skipped.map((f) => f.name).join(" / ")}（読める拡張子: mp3 / wav / m4a / aac / ogg / opus / flac / webm、動画 mp4 / mov / mkv、MIDI mid / midi）`
          : "音声（または音声つき動画）ファイルが見つかりませんでした。",
      );
      return;
    }
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();

    const before = this.tracks.length;
    for (const f of list) {
      this.say(`読み込み中: ${f.name} …`);
      /* 1本ずつ順に読む。並列にすると読み込み中のログが混ざるうえ、
         デコード済みの PCM が一度にメモリへ乗る。 */
      // oxlint-disable-next-line no-await-in-loop
      await (isMidiFile(f) ? this.ingestMidi(ctx, f) : this.decodeInto(ctx, f));
    }
    if (skipped.length) {
      this.say(`${skipped.length}件を対応外としてスキップ: ${skipped.map((f) => f.name).join(" / ")}`);
    }
    /* 再生中に足したトラックも、その場から鳴らす（#50）。移動やトリムと同じ
       扱いで、全部読み終えてから1回だけ組み直す（1本ごとに組み直すと、
       既に鳴っているトラックがファイルの数だけ途切れる）。 */
    if (this.tracks.length > before) this.rebuildIfPlaying();
    this.refreshTelemetry();
    this.emit();
  }

  /**
   * MIDI（#46）。音声ではなく音符イベントなので decodeAudioData には渡さず、
   * SMF を解析して内蔵シンセでレンダーし、チャンネルごとに1本のトラックにする。
   * AudioBuffer になった時点で以降の機能（トリム / FX / バス / 書き出し / 保存）は
   * そのまま効く。
   */
  private async ingestMidi(ctx: AudioContext, f: File): Promise<void> {
    let song: MidiSong;
    try {
      song = parseSmf(await f.arrayBuffer());
    } catch (err) {
      /* 「ブラウザが対応していない」ではなく、読めない理由をそのまま出す。 */
      this.say(
        err instanceof MidiParseError
          ? `${f.name}: ${err.message}`
          : `${f.name} を MIDI として読めませんでした。`,
      );
      return;
    }

    const base = f.name.replace(/\.[^.]+$/, "");
    /* チャンネル10（ドラム）も他と同じく1トラックにする。音色の対応が無い
       ノート（タム類など）だけが鳴らずに残り、その本数を下でまとめて伝える（#58）。 */
    const voices = song.channels;

    let totalMs = 0;
    let totalNotes = 0;
    let unplayable = 0;
    for (const ch of voices) {
      const notes = song.notes.filter((n) => n.channel === ch);
      const part: MidiSong = {
        ...song,
        notes,
        channels: [ch],
        durationSec: notes.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0),
      };
      this.say(`${f.name}: ${channelLabel(ch)} をレンダー中（${notes.length}音）…`);
      // oxlint-disable-next-line no-await-in-loop
      const r = await renderMidi(part, ctx.sampleRate);
      totalMs += r.ms;
      totalNotes += r.rendered;
      unplayable += r.skipped;
      const t = this.push(
        voices.length > 1 ? `${base} ${channelLabel(ch)}` : base,
        f.name,
        f,
        r.buf,
        r.ms,
      );
      t.midiChannel = ch;
    }
    this.decodeTotal += totalMs;
    const rt = totalMs > 0 ? Math.round(song.durationSec / (totalMs / 1000)) : 0;
    this.telemetry = {
      ...this.telemetry,
      midi: `${totalNotes}音 / ${totalMs.toFixed(0)} ms（約${rt}倍速）`,
    };
    this.say(
      `${f.name} — MIDI ${song.notes.length}音 / ${voices.length}トラック（チャンネルごと）/ ` +
        `${song.durationSec.toFixed(2)}s / 内蔵シンセで ${totalMs.toFixed(0)}ms でレンダー` +
        (unplayable
          ? `。うち ${unplayable}音は対応する音色が無いので鳴らしていません（タム・シンバル類）`
          : ""),
    );
  }

  /** 保存された MIDI から、指定チャンネルぶんだけ鳴らし直す（復元用）。 */
  private async renderMidiChannel(
    ctx: AudioContext,
    bytes: ArrayBuffer,
    channel: number | undefined,
  ): Promise<AudioBuffer> {
    const song = parseSmf(bytes);
    const notes =
      channel === undefined ? song.notes : song.notes.filter((n) => n.channel === channel);
    const part: MidiSong = {
      ...song,
      notes,
      channels: channel === undefined ? song.channels : [channel],
      durationSec: notes.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0),
    };
    const r = await renderMidi(part, ctx.sampleRate);
    return r.buf;
  }

  private async decodeInto(ctx: AudioContext, f: File): Promise<void> {
    try {
      const bytes = await f.arrayBuffer();
      const t0 = performance.now();
      const buf = await ctx.decodeAudioData(bytes);
      const ms = performance.now() - t0;
      this.decodeTotal += ms;
      this.push(f.name.replace(/\.[^.]+$/, ""), f.name, f, buf, ms);
      const via = isVideoFile(f) ? "動画から音声のみ取り込み / " : "";
      this.say(
        `${f.name} — ${via}${buf.duration.toFixed(2)}s / ${buf.numberOfChannels}ch / ${buf.sampleRate}Hz / デコード ${ms.toFixed(0)}ms`,
      );
    } catch {
      this.say(
        isVideoFile(f)
          ? `${f.name} から音声を取り出せませんでした（このブラウザはこの動画コンテナの音声デコードに対応していません）`
          : `${f.name} をデコードできませんでした（この形式はブラウザが対応していません）`,
      );
    }
  }

  private push(name: string, srcName: string, srcBytes: Blob, buf: AudioBuffer, ms: number): Track {
    const ctx = this.audio();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    /* エフェクトは常設で gain → EQ3段 → pan に挟む（ゲイン 0dB の棚/ピークは
       素通しなので、未使用でも音は変わらない）。コンプはトグル時に配線する。 */
    const fxLow = makeBiquad(ctx, "lowshelf", EQ_LOW_HZ, 0);
    const fxMid = makeBiquad(ctx, "peaking", EQ_MID_HZ, 0);
    const fxHigh = makeBiquad(ctx, "highshelf", EQ_HIGH_HZ, 0);
    const fxComp = ctx.createDynamicsCompressor();
    gain.connect(fxLow);
    fxLow.connect(fxMid);
    fxMid.connect(fxHigh);
    fxHigh.connect(pan);
    if (this.master) pan.connect(this.master);
    const t: Track = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name,
      srcName,
      srcBytes,
      midiChannel: null,
      drums: null,
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
      bus: null,
      fx: defaultFx(),
      fxLow,
      fxMid,
      fxHigh,
      fxComp,
      color: HUE[this.nextHue++ % HUE.length],
      decodeMs: ms,
      peaks: null,
    };
    gain.gain.value = t.vol;
    this.tracks.push(t);
    this.balance();
    /* トラックが増えた時点で、既存のレンダー結果は今のミックスではない。 */
    this.invalidateRender();
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
    if (this.fxId === id) this.fxId = null;
    if (this.drumsId === id) this.drumsId = null;
    this.stopSrc(t);
    try {
      t.gain.disconnect();
      t.fxLow.disconnect();
      t.fxMid.disconnect();
      t.fxHigh.disconnect();
      t.fxComp.disconnect();
      t.pan.disconnect();
    } catch {
      /* 既に切れているだけなので無視してよい */
    }
    this.tracks = this.tracks.filter((x) => x !== t);
    if (!this.tracks.length) this.halt();
    this.refreshTelemetry();
    this.balance();
    this.touched();
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

  /** シリアライズ可能な現在状態。メタの構築は audio/project.ts に置く。 */
  exportProject(): { meta: ProjectMeta; blobs: Blob[] } | null {
    if (!this.tracks.length) return null;
    return {
      meta: projectMetaOf(this.tracks, this.masterVol, this.pxPerSec, this.busVol),
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
      /* MIDI 由来のトラックは元バイト列が .mid なので decodeAudioData では
         復元できない。取り込みと同じ解析＋レンダーを通す（#46）。 */
      /* 生成トラック（MIDI / ドラム）は元バイト列が音声ではないので、
         decodeAudioData ではなくそれぞれのレンダー経路を通す。 */
      const drums = isDrumsFile({ name: m.srcName })
        ? decodeDrumPattern(new TextDecoder().decode(bytes))
        : null;
      const decoding = drums
        ? renderDrums(drums, ctx.sampleRate).then((r) => r.buf)
        : isMidiFile({ name: m.srcName })
          ? this.renderMidiChannel(ctx, bytes, m.midiChannel)
          : ctx.decodeAudioData(bytes);
      // oxlint-disable-next-line no-await-in-loop
      const buf = await decoding;
      const ms = performance.now() - t0;
      this.decodeTotal += ms;
      const t = this.push(m.name, m.srcName, blobs[i], buf, ms);
      t.midiChannel = m.midiChannel ?? null;
      t.drums = drums;
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
      this.applyFx(t, m.fx);
      t.color = m.color;
      t.bus = m.bus ?? null;
      this.routeTrack(t);
    }
    this.nextHue = this.tracks.length;
    for (const b of BUS_IDS) {
      /* バス導入前の保存には busVol が無い。その場合は素通し（1.0）。 */
      this.busVol[b] = clamp(meta.busVol?.[b] ?? 1, 0, 1.4);
      if (this.busGain) this.busGain[b].gain.value = this.busVol[b];
    }
    this.masterVol = clamp(meta.masterVol, 0, 1.4);
    if (this.master) this.master.gain.value = this.masterVol;
    this.pxPerSec = clamp(meta.pxPerSec, 8, 400);
    this.balance();
    this.refreshTelemetry();
    this.touched();
  }

  /* ── ドラム（#54） ─────────────────────────────────────────────────── */

  /**
   * パターンから AudioBuffer を作ってトラックに載せ替える。追加も編集も
   * ここを通る。元ファイルが無い生成トラックなので、`srcBytes` にはパターンの
   * JSON を入れておく——保存（#18）はトラック1本につき Blob 1つを前提に
   * していて、これが音の正本になる。
   */
  private async renderDrumsInto(t: Track, pattern: DrumPattern): Promise<void> {
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();
    /* 連打されると古いレンダーが後から返ることがあるので、最後の1回だけ採る。 */
    const gen = ++this.drumGen;
    const { buf, ms, hits } = await renderDrums(pattern, ctx.sampleRate);
    if (gen !== this.drumGen || !this.tracks.includes(t)) return;

    t.drums = pattern;
    t.buf = buf;
    t.srcBytes = new Blob([encodeDrumPattern(pattern)], { type: "application/json" });
    /* 尺が変わるので、トリムとフェードは掛け直しになる（黙って範囲外の値を
       残すと再生とクリップ表示が食い違う）。 */
    t.trimStart = 0;
    t.trimEnd = buf.duration;
    t.fadeIn = 0;
    t.fadeOut = 0;
    t.peaks = null;
    this.say(
      `${t.name} — ${pattern.bpm}BPM / ${pattern.bars}小節 / ${hits}発 / ${buf.duration.toFixed(2)}s（レンダー ${ms.toFixed(0)}ms）`,
    );
    this.rebuildIfPlaying();
    this.touched();
  }

  /** ドラムトラックを1本足して格子を開く。プリセットから始める（#54）。 */
  async addDrums(): Promise<void> {
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();
    const pattern: DrumPattern = { ...emptyPattern(120, 2), hits: presetHits("four") };
    const { buf, ms } = await renderDrums(pattern, ctx.sampleRate);
    const name = `ドラム ${++this.drumCount}`;
    const t = this.push(
      name,
      `${name}.drums.json`,
      new Blob([encodeDrumPattern(pattern)], { type: "application/json" }),
      buf,
      ms,
    );
    t.drums = pattern;
    this.drumsId = t.id;
    this.refreshTelemetry();
    this.rebuildIfPlaying();
    this.say(`${name} を追加しました（${pattern.bpm}BPM / ${pattern.bars}小節）。`);
    this.touched();
  }

  toggleDrumPanel(id: string): void {
    this.drumsId = this.drumsId === id ? null : id;
    this.emit();
  }

  /** 格子のマス目。押した瞬間に鳴りが変わるよう、その場で作り直す。 */
  toggleDrumStep(id: string, voice: DrumVoice, step: number): void {
    const t = this.find(id);
    if (!t?.drums) return;
    const hits = { ...t.drums.hits, [voice]: [...t.drums.hits[voice]] };
    hits[voice][step] = !hits[voice][step];
    void this.renderDrumsInto(t, { ...t.drums, hits });
  }

  setDrumBpm(id: string, bpm: number): void {
    const t = this.find(id);
    if (!t?.drums) return;
    void this.renderDrumsInto(t, { ...t.drums, bpm });
  }

  setDrumBars(id: string, bars: number): void {
    const t = this.find(id);
    if (!t?.drums) return;
    void this.renderDrumsInto(t, { ...t.drums, bars });
  }

  /** プリセットで格子を置き換える。BPM と小節数は今の値を引き継ぐ。 */
  applyDrumPreset(id: string, preset: PresetId): void {
    const t = this.find(id);
    if (!t?.drums) return;
    void this.renderDrumsInto(t, { ...t.drums, hits: presetHits(preset) });
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
    const res = await openMic(this.audio(), () => void this.finishRecording());
    if ("error" in res) {
      this.say(res.error);
      return;
    }
    this.rec = res.rec;
    this.recTick();
    this.say("録音中 … もう一度 ● を押すと停止してトラックになります。");
  }

  /** 停止後の後始末とトラック化。Blob 以降は読み込みと同じ decode → push の経路。 */
  private async finishRecording(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    cancelAnimationFrame(this.recRaf);
    const blob = collectRecording(rec);
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
      /* 再生に重ねて録った場合、止めた時点から録音トラックも鳴る（#50）。
         これが無いと、オーバーダブは一度停止しないと聴き返せない。 */
      this.rebuildIfPlaying();
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

  /* ── グループバス ──────────────────────────────────────────────────── */

  /** トラックの出口（pan）を、割り当てに従ってバスか Master に繋ぎ直す。 */
  private routeTrack(t: Track): void {
    try {
      t.pan.disconnect();
    } catch {
      /* 未接続なだけ */
    }
    const dest = t.bus && this.busGain ? this.busGain[t.bus] : this.master;
    if (dest) t.pan.connect(dest);
  }

  /** バスの割り当て。`null` で外して Master 直結に戻す。再生中も即座に効く。 */
  setBus(id: string, bus: BusId | null): void {
    const t = this.find(id);
    if (!t || t.bus === bus) return;
    t.bus = bus;
    this.routeTrack(t);
    this.invalidateRender();
    /* say() が emit まで面倒を見るので、ここは捨てるだけでよい。 */
    this.say(
      bus
        ? `${t.name} → ${BUS_INFO[bus].label}バス（${BUS_INFO[bus].sister}）`
        : `${t.name} をバスから外しました（Master 直結）`,
    );
  }

  setBusVol(bus: BusId, v: number): void {
    this.busVol[bus] = v;
    if (this.busGain) this.busGain[bus].gain.value = v;
    this.touched();
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
    this.touched();
  }

  setPan(id: string, v: number): void {
    const t = this.find(id);
    if (!t) return;
    t.panv = v;
    t.pan.pan.value = v;
    this.touched();
  }

  toggleSolo(id: string): void {
    const t = this.find(id);
    if (!t) return;
    t.solo = !t.solo;
    this.balance();
    this.touched();
  }

  toggleMute(id: string): void {
    const t = this.find(id);
    if (!t) return;
    t.mute = !t.mute;
    this.balance();
    this.touched();
  }

  setMaster(v: number): void {
    this.masterVol = v;
    if (this.master) this.master.gain.value = v;
    this.touched();
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
    this.touched();
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
    this.touched();
  }

  /* ── エフェクト ────────────────────────────────────────────────────── */

  toggleFxPanel(id: string): void {
    this.fxId = this.fxId === id ? null : id;
    this.emit();
  }

  /** EQ のバンドゲイン（dB）。常設ノードなので再生中でも即座に効く。 */
  setEq(id: string, band: "low" | "mid" | "high", dB: number): void {
    const t = this.find(id);
    if (!t) return;
    t.fx.eq[band] = dB;
    const node = band === "low" ? t.fxLow : band === "mid" ? t.fxMid : t.fxHigh;
    node.gain.value = dB;
    this.touched();
  }

  setComp(id: string, key: "threshold" | "ratio" | "attack" | "release", v: number): void {
    const t = this.find(id);
    if (!t) return;
    t.fx.comp[key] = v;
    t.fxComp[key].value = v;
    this.touched();
  }

  /**
   * 復元した fx を今の実装の範囲にクランプして、データと常設ノードの両方へ
   * 反映する。データを代入するだけではノードに乗らないので必ずここを通す。
   */
  private applyFx(t: Track, fx: TrackFx): void {
    t.fx.eq.low = clamp(fx.eq.low, -12, 12);
    t.fx.eq.mid = clamp(fx.eq.mid, -12, 12);
    t.fx.eq.high = clamp(fx.eq.high, -12, 12);
    t.fxLow.gain.value = t.fx.eq.low;
    t.fxMid.gain.value = t.fx.eq.mid;
    t.fxHigh.gain.value = t.fx.eq.high;
    t.fx.comp.threshold = clamp(fx.comp.threshold, -60, 0);
    t.fx.comp.ratio = clamp(fx.comp.ratio, 1, 20);
    t.fx.comp.attack = clamp(fx.comp.attack, 0.001, 0.1);
    t.fx.comp.release = clamp(fx.comp.release, 0.05, 1);
    /* 直後の push() ではコンプは未配線（OFF）なので、ON ならトグルで配線する。 */
    if (fx.comp.on !== t.fx.comp.on) this.toggleComp(t.id);
  }

  /** コンプの ON/OFF。素通しを保証するため、OFF は配線ごと外す。 */
  toggleComp(id: string): void {
    const t = this.find(id);
    if (!t) return;
    t.fx.comp.on = !t.fx.comp.on;
    t.fxHigh.disconnect();
    t.fxComp.disconnect();
    if (t.fx.comp.on) {
      const c = t.fxComp;
      c.threshold.value = t.fx.comp.threshold;
      c.ratio.value = t.fx.comp.ratio;
      c.attack.value = t.fx.comp.attack;
      c.release.value = t.fx.comp.release;
      t.fxHigh.connect(c);
      c.connect(t.pan);
    } else {
      t.fxHigh.connect(t.pan);
    }
    this.touched();
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
    this.touched();
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
        scheduleFades(f.gain, at - local, eff, t.fadeIn, t.fadeOut);
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

  /**
   * 書き出しは同時に1つだけ（#51）。webm は実時間かかるので、その最中に
   * WAV / MP3 を押せると同じミックスのレンダーが2本並走し、長尺ではピーク
   * メモリが倍になるうえ、ログ行が1つしかないので後着が先の結果を消す。
   */
  private get exporting(): boolean {
    return this.bouncing || this.webmBusy || this.mp3Busy;
  }

  async bounce(): Promise<void> {
    const dur = this.total();
    if (!dur || this.exporting) return;
    this.audio();
    this.bouncing = true;
    this.say("オフラインでミックスを描画中 …");

    /* 失敗しても bouncing を必ず戻す。長尺では encodeWav のメモリ確保が
       落ちることが現実にあり、ここで戻さないと書き出しボタンが死んだままになる。 */
    try {
      const { rendered, ms } = await this.renderMix(dur);
      const wav = encodeWav(rendered);
      const rt = (dur / (ms / 1000)).toFixed(0);
      const size = (wav.size / 1048576).toFixed(1);
      this.say(
        `レンダー完了: ${dur.toFixed(2)}s / ${size}MB / 実時間の約${rt}倍速。保存を試みています …`,
      );

      await deliverWav(wav, rt, size, (m) => this.say(m));
    } catch (err) {
      this.say(`書き出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.bouncing = false;
      this.emit();
    }
  }

  /** ミックスをオフラインで一括レンダーして lastRender に置く。WAV / webm / MP3 共用。 */
  private async renderMix(dur: number): Promise<{ rendered: AudioBuffer; ms: number }> {
    const { rendered, ms } = await renderMix(this.audio(), this.tracks, this.masterVol, this.busVol, dur);
    this.telemetry = { ...this.telemetry, offline: `${ms.toFixed(0)} ms`, offlineOk: true };
    this.lastRender = rendered;
    return { rendered, ms };
  }

  /**
   * webm（Opus）の書き出し。オフラインの一括レンダーと違い、レンダー結果を
   * MediaStreamAudioDestinationNode へ等速再生して MediaRecorder で録るので
   * **仕様上、実時間かかる**。スピーカーには出さない（無音で録れる）。
   */
  async bounceWebm(): Promise<void> {
    const dur = this.total();
    if (!dur || this.exporting) return;
    if (!webmSupported()) {
      this.say("このブラウザは webm (Opus) の録音に対応していません。WAV の書き出しを使ってください。");
      return;
    }
    const ctx = this.audio();
    if (ctx.state === "suspended") await ctx.resume();
    this.webmBusy = true;
    this.say("webm 書き出し: まずミックスをレンダーしています …");
    try {
      const { rendered } = await this.renderMix(dur);
      const blob = await recordToWebm(ctx, rendered, (el, total) =>
        this.say(`webm 書き出し中（実時間）… ${el.toFixed(0)}s / ${total.toFixed(0)}s`),
      );
      const size = (blob.size / 1048576).toFixed(1);
      this.telemetry = { ...this.telemetry, webm: `${rendered.duration.toFixed(1)} s（実時間）` };
      const ok = await deliverBlob(blob, "prism-river-mix.webm");
      this.say(
        ok
          ? `webm を書き出しました: ${dur.toFixed(2)}s / ${size}MB（Opus・実時間の1.0倍。WAV の一括レンダーと違い実時間かかるのは仕様）。`
          : `webm のレンダーは完了（${size}MB）。ただしこのビューではファイル保存が使えません。`,
      );
    } catch (err) {
      this.say(`webm の書き出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.webmBusy = false;
      this.emit();
    }
  }

  /**
   * MP3（LAME / WASM）の書き出し（#20）。オフラインの一括レンダー →
   * Worker 内の WASM でエンコード。webm（実時間）と違いどちらも実時間より
   * 速い想定で、**「エンコードを足しても書き出しは数百倍速のままか」を
   * 実測するのがこの機能の目的**。結果はテレメトリと README に残す。
   */
  async bounceMp3(): Promise<void> {
    const dur = this.total();
    if (!dur || this.exporting) return;
    this.audio();
    this.mp3Busy = true;
    this.say("MP3 書き出し: まずミックスをレンダーしています …");
    try {
      const { rendered, ms: renderMs } = await this.renderMix(dur);
      this.say("MP3 書き出し: WASM（LAME）でエンコード中 …");
      const { bytes, ms: encodeMs } = await encodeMp3InWorker(rendered);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const rt = (dur / (encodeMs / 1000)).toFixed(0);
      this.telemetry = { ...this.telemetry, mp3: `${encodeMs.toFixed(0)} ms（約${rt}倍速）` };
      const size = (blob.size / 1048576).toFixed(2);
      const ok = await deliverBlob(blob, "prism-river-mix.mp3");
      this.say(
        ok
          ? `MP3 を書き出しました: ${dur.toFixed(2)}s / ${size}MB（CBR ${MP3_KBPS}kbps）。レンダー ${renderMs.toFixed(0)}ms + エンコード ${encodeMs.toFixed(0)}ms — エンコードは実時間の約${rt}倍速。`
          : `MP3 のエンコードは完了（${size}MB / 実時間の約${rt}倍速）。ただしこのビューではファイル保存が使えません。`,
      );
    } catch (err) {
      this.say(`MP3 の書き出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.mp3Busy = false;
      this.emit();
    }
  }

  audition(): void {
    if (!this.lastRender || !this.ctx || !this.master) return;
    if (this.auditionSrc) {
      this.stopAudition();
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

  private stopAudition(): void {
    if (!this.auditionSrc) return;
    try {
      this.auditionSrc.stop();
    } catch {
      /* 既に終わっている */
    }
    this.auditionSrc = null;
  }
}
