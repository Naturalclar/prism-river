import wasmUrl from "rubberband-wasm/dist/rubberband.wasm?url";
import { stretchPcm, type StretchParams } from "../lib/stretch";

/**
 * タイムストレッチを回す Worker（#25）。MP3（#20）と同じ置き方で、
 * オフライン処理なので AudioWorklet ではなくここ。
 *
 * WASM（約 265KB）はこのチャンクに閉じるので、ストレッチを使わない限り
 * メインバンドルには乗らない。モジュールは1度だけ compile して使い回す
 * （トラックごとに読み直すと、尺より compile の方が高くつく）。
 */

type Req = { channels: Float32Array[]; sampleRate: number; params: StretchParams };
type Res =
  | { ok: true; channels: Float32Array<ArrayBuffer>[]; ms: number }
  | { ok: false; error: string };

const scope = self as unknown as Worker;

let compiled: Promise<WebAssembly.Module> | null = null;
const wasm = () => (compiled ??= WebAssembly.compileStreaming(fetch(wasmUrl)));

scope.addEventListener("message", (e: MessageEvent<Req>) => {
  void (async () => {
    try {
      const mod = await wasm();
      const t0 = performance.now();
      const channels = await stretchPcm(mod, e.data.channels, e.data.sampleRate, e.data.params);
      const ms = performance.now() - t0;
      const res: Res = { ok: true, channels, ms };
      scope.postMessage(
        res,
        channels.map((c) => c.buffer),
      );
    } catch (err) {
      const res: Res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      /* Worker の postMessage に targetOrigin は無い（window 向けルールの誤検知）。 */
      // oxlint-disable-next-line require-post-message-target-origin
      scope.postMessage(res);
    }
  })();
});
