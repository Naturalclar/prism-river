import { RubberBandInterface } from "rubberband-wasm";

/**
 * タイムストレッチ / ピッチシフト（#25）。Rubber Band Library 3.3.0 の
 * WASM ビルド（`rubberband-wasm`）を回す。
 *
 * - ここは DOM に依存しない: Worker（`src/audio/stretchworker.ts`）からも
 *   vitest（Node）からも同じコードが動く。WASM モジュールだけ外から渡す
 *   （ブラウザは `?url` + `compileStreaming`、Node は読んで `compile`）
 * - オフライン適用。study → process → retrieve の2パスで、リアルタイム用の
 *   AudioWorklet 経路は持たない（Issue #25 の「まずオフライン」）
 * - ライセンス: Rubber Band は GPL v2 **or later**（本家 README の
 *   「either version 2 of the License, or (at your option) any later version」）。
 *   リポジトリは GPL-3.0-only（#19）なので取り込める。#19 はまさにこれを
 *   残すための決定だった
 */

/** テンポ（1 = 等倍、0.5 = 半分の速さ）。Rubber Band の品質が保てる範囲に切る。 */
export const TEMPO_MIN = 0.5;
export const TEMPO_MAX = 2;
/** ピッチ（半音）。上下1オクターブ。 */
export const SEMITONE_MIN = -12;
export const SEMITONE_MAX = 12;

export type StretchParams = {
  /** 再生速度の倍率。0.5 なら半分の速さ＝尺は2倍。 */
  tempo: number;
  /** ピッチの移動量（半音）。テンポとは独立。 */
  semitones: number;
};

export const NO_STRETCH: StretchParams = { tempo: 1, semitones: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** UI や保存データから来た値を実装の範囲に丸める。壊れた値は等倍に倒す。 */
export function normalizeStretch(p: Partial<StretchParams> | null | undefined): StretchParams {
  const tempo = Number.isFinite(p?.tempo) ? clamp(p?.tempo as number, TEMPO_MIN, TEMPO_MAX) : 1;
  const semitones = Number.isFinite(p?.semitones)
    ? Math.round(clamp(p?.semitones as number, SEMITONE_MIN, SEMITONE_MAX))
    : 0;
  return { tempo, semitones };
}

/** 等倍・無変化か。真なら WASM を回さずに元のバッファへ戻せる。 */
export function isIdentity(p: StretchParams): boolean {
  return p.tempo === 1 && p.semitones === 0;
}

/** Rubber Band の time ratio（出力の長さ / 入力の長さ）。テンポの逆数。 */
export function timeRatio(p: StretchParams): number {
  return 1 / p.tempo;
}

/** Rubber Band の pitch scale（周波数の倍率）。半音 n は 2^(n/12)。 */
export function pitchScale(p: StretchParams): number {
  return 2 ** (p.semitones / 12);
}

/** 処理後のサンプル数。クリップの尺と時計がここで決まる。 */
export function stretchedLength(inputLength: number, p: StretchParams): number {
  return Math.max(1, Math.round(inputLength * timeRatio(p)));
}

/**
 * 尺が変わったぶんトリム・フェードの秒数を伸縮させる。
 *
 * これをしないと、0.5倍速にした瞬間に「後半を捨てるトリム」が曲の真ん中を
 * 指すようになる——音は鳴っているのに切れる位置だけずれる、という気づき
 * にくい壊れ方をする。比率は尺の比そのもの。
 */
export function rescaleSeconds(sec: number, fromDuration: number, toDuration: number): number {
  if (fromDuration <= 0) return sec;
  return (sec * toDuration) / fromDuration;
}

/**
 * PCM にストレッチをかける。入力は触らず、新しい Float32Array を返す。
 *
 * 出力長は `stretchedLength()` ぴったりに揃える。Rubber Band が数サンプル
 * 多く / 少なく返すことがあり、そのぶん尺が揺れるとクリップの幅と時計が
 * 素材ごとに微妙にずれるため（余ったら捨て、足りなければ無音で埋める）。
 */
export async function stretchPcm(
  wasm: WebAssembly.Module,
  channels: readonly Float32Array[],
  sampleRate: number,
  params: StretchParams,
): Promise<Float32Array<ArrayBuffer>[]> {
  if (!channels.length) throw new Error("チャンネルがありません");
  const p = normalizeStretch(params);
  const n = channels[0].length;
  const outLength = stretchedLength(n, p);

  const api = await RubberBandInterface.initialize(wasm);
  /* options=0 は ProcessOffline + 既定（Elastic / Crisp / Compound …）。
     オフラインは study で全体を見てから process するので、リアルタイムより
     素直に伸びる。 */
  const state = api.rubberband_new(sampleRate, channels.length, 0, timeRatio(p), pitchScale(p));

  /* 出力は要求長ぴったりに詰めるが、retrieve は最後にまとめて溢れることが
     あるので、書き込み先だけ1ブロックぶん余裕を持たせる。 */
  const block = api.rubberband_get_samples_required(state);
  const out = channels.map(() => new Float32Array(outLength + block));

  /* チャンネルごとの入出力バッファ（WASM ヒープ）と、その先頭を並べた配列。 */
  const arrayPtr = api.malloc(channels.length * 4);
  const dataPtr: number[] = [];
  for (let c = 0; c < channels.length; c++) {
    const ptr = api.malloc(block * 4);
    dataPtr.push(ptr);
    api.memWritePtr(arrayPtr + c * 4, ptr);
  }

  try {
    api.rubberband_set_expected_input_duration(state, n);

    /* 1パス目: 全体を眺めさせる（オフラインではこれが要る）。 */
    for (let read = 0; read < n; ) {
      const take = Math.min(block, n - read);
      channels.forEach((ch, i) => api.memWrite(dataPtr[i], ch.subarray(read, read + take)));
      read += take;
      api.rubberband_study(state, arrayPtr, take, read >= n ? 1 : 0);
    }

    /* 2パス目: 流し込みながら出てきたぶんを回収する。 */
    let write = 0;
    const drain = (final: boolean) => {
      for (;;) {
        const available = api.rubberband_available(state);
        if (available < 1) break;
        /* 途中は1ブロック貯まってから引く（細切れに引くと呼び出し回数だけ増える）。 */
        if (!final && available < block) break;
        const got = api.rubberband_retrieve(state, arrayPtr, Math.min(block, available));
        if (got < 1) break;
        dataPtr.forEach((ptr, i) => out[i].set(api.memReadF32(ptr, got), write));
        write += got;
        if (write >= out[0].length) break;
      }
    };
    for (let read = 0; read < n; ) {
      const take = Math.min(block, n - read);
      channels.forEach((ch, i) => api.memWrite(dataPtr[i], ch.subarray(read, read + take)));
      read += take;
      api.rubberband_process(state, arrayPtr, take, read >= n ? 1 : 0);
      drain(false);
    }
    drain(true);

    return out.map((ch) => ch.subarray(0, outLength).slice());
  } finally {
    dataPtr.forEach((ptr) => api.free(ptr));
    api.free(arrayPtr);
    api.rubberband_delete(state);
  }
}
