import { encodeMp3 } from "../lib/mp3";

/**
 * MP3 エンコードを回す Worker（#20）。リアルタイム性の無いオフライン処理なので
 * AudioWorklet ではなくここ（HANDOFF「Worker + WASM で十分」の通り）。
 * メインスレッドを塞がないので、長尺でも UI とログが生きたまま進む。
 */

type Req = { channels: Float32Array[]; sampleRate: number };
type Res = { ok: true; bytes: Uint8Array<ArrayBuffer>; ms: number } | { ok: false; error: string };

const scope = self as unknown as Worker;

scope.addEventListener("message", (e: MessageEvent<Req>) => {
  void (async () => {
    try {
      const t0 = performance.now();
      const bytes = await encodeMp3(e.data.channels, e.data.sampleRate);
      const ms = performance.now() - t0;
      const res: Res = { ok: true, bytes, ms };
      scope.postMessage(res, [bytes.buffer]);
    } catch (err) {
      const res: Res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      /* Worker の postMessage に targetOrigin は無い（window 向けルールの誤検知）。 */
      // oxlint-disable-next-line require-post-message-target-origin
      scope.postMessage(res);
    }
  })();
});
