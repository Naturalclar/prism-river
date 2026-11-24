import { BUS_IDS, type BusId, type BusVols } from "../lib/store";
import { buildFxChain, connectRoom, ROOM_SECONDS, scheduleFades } from "./graph";
import type { Downloads, Track } from "./types";

/** webm 書き出しのコンテナ。MediaRecorder の対応はブラウザ依存なので使用前に確認する。 */
export const WEBM_MIME = "audio/webm;codecs=opus";

export function webmSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(WEBM_MIME);
}

/** ミックスをオフラインで一括レンダーする。WAV / webm 共用。 */
export async function renderMix(
  ctx: AudioContext,
  tracks: Track[],
  masterVol: number,
  busVol: BusVols,
  dur: number,
  preview?: { origin: number; bypass?: string },
): Promise<{ rendered: AudioBuffer; ms: number }> {
  const t0 = performance.now();
  const sr = ctx.sampleRate;
  const solo = tracks.some((t) => t.solo);
  const audible = tracks.filter((t) => !t.mute && (!solo || t.solo));
  const end = audible.reduce((latest, t) => (t.fx.room > 0
    ? Math.max(latest, t.offset + t.trimEnd - t.trimStart + ROOM_SECONDS)
    : latest), dur);
  const origin = preview?.origin ?? 0;
  const frames = preview ? Math.round(dur * sr) - Math.round(origin * sr)
    : Math.ceil(end * sr) + Math.floor(sr * 0.1);
  const off = new OfflineAudioContext(2, frames, sr);
  const mg = off.createGain();
  mg.gain.value = masterVol;
  mg.connect(off.destination);
  /* リアルタイム側と同じバス構造をオフラインにも組む。 */
  const busG = {} as Record<BusId, GainNode>;
  for (const bus of BUS_IDS) {
    const g = off.createGain();
    g.gain.value = busVol[bus];
    g.connect(mg);
    busG[bus] = g;
  }
  for (const t of audible) {
    const eff = t.trimEnd - t.trimStart;
    const clipAt = t.offset - origin;
    const skip = Math.max(0, -clipAt);
    if (skip >= eff || (preview && t.offset >= dur)) continue;
    const g = off.createGain();
    const p = off.createStereoPanner();
    const s = off.createBufferSource();
    g.gain.value = t.vol;
    p.pan.value = t.panv;
    s.buffer = t.buf;
    if (t.fadeIn > 0 || t.fadeOut > 0) {
      const f = off.createGain();
      scheduleFades(f.gain, clipAt, eff, t.fadeIn, t.fadeOut);
      s.connect(f);
      f.connect(g);
    } else {
      s.connect(g);
    }
    /* エフェクトはプレーンなデータからオフライン側のノードを組み直す。
       素通し（EQ 全バンド 0dB・コンプ OFF）のときは挟まない。 */
    const bypass = preview?.bypass === t.id;
    const chain = bypass ? null : buildFxChain(off, t.fx);
    if (chain) {
      g.connect(chain.input);
      chain.output.connect(p);
    } else {
      g.connect(p);
    }
    if (!bypass && t.fx.room > 0) connectRoom(off, chain?.output ?? g, p, t.fx.room);
    p.connect(t.bus ? busG[t.bus] : mg);
    s.start(Math.max(0, clipAt), t.trimStart + skip, eff - skip);
  }
  const rendered = await off.startRendering();
  return { rendered, ms: performance.now() - t0 };
}

/**
 * レンダー済みバッファを MediaStreamAudioDestinationNode へ等速再生しながら
 * MediaRecorder で録る。**仕様上、実時間かかる**。スピーカーには出さない。
 */
export function recordToWebm(
  ctx: AudioContext,
  buf: AudioBuffer,
  onProgress: (elapsed: number, total: number) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const dest = ctx.createMediaStreamDestination();
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: WEBM_MIME });
    const chunks: Blob[] = [];
    const t0 = ctx.currentTime;
    const timer = setInterval(() => {
      onProgress(Math.min(buf.duration, ctx.currentTime - t0), buf.duration);
    }, 1000);
    const finish = (fn: () => void) => {
      clearInterval(timer);
      try {
        dest.disconnect();
      } catch {
        /* 既に切れている */
      }
      fn();
    };
    rec.addEventListener("dataavailable", (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    rec.addEventListener("error", () => finish(() => reject(new Error("MediaRecorder が失敗しました"))));
    rec.addEventListener("stop", () => finish(() => resolve(new Blob(chunks, { type: WEBM_MIME }))));
    s.addEventListener(
      "ended",
      () => {
        if (rec.state !== "inactive") rec.stop();
      },
      { once: true },
    );
    rec.start();
    s.start();
  });
}

/** WAV 以外の汎用保存。ビューア内なら downloads capability、素なら通常ダウンロード。 */
export async function deliverBlob(blob: Blob, filename: string): Promise<boolean> {
  if (!window.claude) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }
  let dl: Downloads | null = null;
  try {
    dl = await window.claude.use("downloads");
  } catch {
    dl = null;
  }
  if (!dl) return false;
  try {
    await dl.save({ filename, data: blob });
    return true;
  } catch {
    return false;
  }
}

/**
 * WAV の保存。claude.ai のビューア内でだけ `window.claude` が生える。自分の
 * ドメインに置いたときは存在しないので、その場合は通常のダウンロードに落とす。
 * 結果の言い回しがエラーコードごとに違うので、メッセージは say で返す。
 */
export async function deliverWav(
  wav: Blob,
  rt: string,
  size: string,
  say: (m: string) => void,
  filename = "prism-river-mix.wav",
): Promise<void> {
  if (!window.claude) {
    const url = URL.createObjectURL(wav);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    say(`書き出しました: ${size}MB / 実時間の約${rt}倍速。`);
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
    say(
      `レンダー完了（${rt}倍速, ${size}MB）。このビューではファイル保存が使えないので、試聴のみ可能です。`,
    );
    return;
  }
  try {
    await dl.save({ filename, data: wav });
    say(`保存しました。レンダーは実時間の約${rt}倍速（${size}MB）。`);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "rejected_extension" || code === "extension_not_enabled") {
      say(
        `レンダーは成功（${rt}倍速, ${size}MB）。ただし .wav はこのビューアの保存許可リストに無いため書き出せません — ブラウザの制限ではなく claude.ai 側の制限なので、自分のドメインに置けば普通に保存できます。ここでは「レンダーを試聴」で結果を確認してください。`,
      );
    } else if (code === "too_large") {
      say(
        `レンダーは成功したが ${size}MB は保存上限(16MiB)超え。尺を削るか、自分のドメインで動かしてください。`,
      );
    } else if (code === "declined") {
      say("保存はキャンセルされました。レンダー結果は「レンダーを試聴」で確認できます。");
    } else {
      say(`レンダーは成功（${rt}倍速）。保存は失敗しました: ${code ?? "不明なエラー"}`);
    }
  }
}
