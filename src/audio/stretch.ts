import type { StretchParams } from "../lib/stretch";

/**
 * AudioBuffer に Worker でタイムストレッチをかけて、新しい AudioBuffer を返す（#25）。
 *
 * PCM の渡し方は MP3（#20）と同じ。AudioBuffer の実体を transfer すると
 * detach されて再生が壊れるので、コピーを作ってそれを transfer する。
 * 戻りも transfer で受けるので、往復でコピーは1本ぶんに収まる。
 *
 * 元のバッファは呼び出し側（Engine）が持ち続ける——比率を変えるたびに
 * **かけ直す**のではなく**かけ替える**ためで、ストレッチを重ねると音が痩せる。
 */
export function stretchInWorker(
  ctx: BaseAudioContext,
  buf: AudioBuffer,
  params: StretchParams,
  signal?: AbortSignal,
): Promise<{ buf: AudioBuffer; ms: number }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const w = new Worker(new URL("./stretchworker.ts", import.meta.url), { type: "module" });
    const abort = () => done(() => reject(signal?.reason));
    const done = (fn: () => void) => {
      signal?.removeEventListener("abort", abort);
      w.terminate();
      fn();
    };

    signal?.addEventListener("abort", abort, { once: true });
    w.addEventListener(
      "message",
      (e: MessageEvent<{ ok: boolean; channels?: Float32Array<ArrayBuffer>[]; ms?: number; error?: string }>) => {
        const d = e.data;
        if (!d.ok || !d.channels || d.ms === undefined) {
          done(() => reject(new Error(d.error ?? "タイムストレッチに失敗しました")));
          return;
        }
        const { channels, ms } = d;
        try {
          const out = ctx.createBuffer(channels.length, channels[0].length, buf.sampleRate);
          channels.forEach((ch, i) => out.copyToChannel(ch, i));
          done(() => resolve({ buf: out, ms }));
        } catch (err) {
          done(() => reject(err));
        }
      },
    );
    w.addEventListener("error", (e) =>
      done(() => reject(new Error(e.message || "ストレッチ Worker の起動に失敗しました"))),
    );

    try {
      const channels: Float32Array<ArrayBuffer>[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
      w.postMessage(
        { channels, sampleRate: buf.sampleRate, params },
        channels.map((c) => c.buffer),
      );
    } catch (err) {
      done(() => reject(err));
    }
  });
}
