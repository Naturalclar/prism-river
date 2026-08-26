/**
 * マイク録音のセッション管理。グラフやトラック化は Engine 側の仕事で、
 * ここは「マイクを開いて MediaRecorder を回す」「後始末して Blob を返す」だけ。
 */
export type RecSession = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Uint8Array<ArrayBuffer>;
};

/** マイクを開いて録音を始める。失敗はユーザー向けメッセージで返す。 */
export async function openMic(
  ctx: AudioContext,
  onStop: () => void,
): Promise<{ rec: RecSession } | { error: string }> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return { error: "このブラウザではマイク録音（getUserMedia / MediaRecorder）が使えません。" };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        error:
          "マイクの使用が許可されませんでした。ブラウザのサイト設定でマイクを許可してから、もう一度 ● を押してください。",
      };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return { error: "マイクが見つかりませんでした。入力デバイスの接続を確認してください。" };
    }
    return { error: `マイクを開けませんでした: ${err instanceof Error ? err.message : String(err)}` };
  }

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
  recorder.addEventListener("stop", onStop, { once: true });
  recorder.start();

  return {
    rec: { stream, recorder, chunks, source, analyser, buf: new Uint8Array(analyser.fftSize) },
  };
}

/** 停止後の後始末。エンコード済みチャンクをまとめて返す。 */
export function collectRecording(rec: RecSession): Blob {
  for (const trk of rec.stream.getTracks()) trk.stop();
  try {
    rec.source.disconnect();
  } catch {
    /* 既に切れている */
  }
  return new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" });
}
