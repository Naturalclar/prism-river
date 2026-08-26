/**
 * レンダー済み AudioBuffer を Worker で MP3 にする（#20）。
 *
 * PCM の渡し方: AudioBuffer の実体（getChannelData の ArrayBuffer）を
 * transfer すると detach されて試聴や再書き出しが壊れるので、コピーを作って
 * それを transfer する。一時的に PCM 1本ぶんメモリが増えるが、エンコードが
 * 済めば解放される（ゼロコピーにするには SharedArrayBuffer＝クロスオリジン
 * 分離が要るので、まずはこの形で測る。HANDOFF「メモリの二重持ち」参照）。
 */
export function encodeMp3InWorker(
  buf: AudioBuffer,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; ms: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./mp3worker.ts", import.meta.url), { type: "module" });
    const done = (fn: () => void) => {
      w.terminate();
      fn();
    };
    w.addEventListener("message", (e: MessageEvent<{ ok: boolean; bytes?: Uint8Array<ArrayBuffer>; ms?: number; error?: string }>) => {
      const d = e.data;
      if (d.ok && d.bytes && d.ms !== undefined) {
        const { bytes, ms } = d;
        done(() => resolve({ bytes, ms }));
      } else {
        done(() => reject(new Error(d.error ?? "MP3 エンコードに失敗しました")));
      }
    });
    w.addEventListener("error", (e) => done(() => reject(new Error(e.message || "MP3 Worker の起動に失敗しました"))));

    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
      channels.push(buf.getChannelData(c).slice());
    }
    w.postMessage(
      { channels, sampleRate: buf.sampleRate },
      channels.map((c) => c.buffer),
    );
  });
}
