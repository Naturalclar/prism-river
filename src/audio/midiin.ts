import { parseMidiMessage, type MidiInEvent } from "../lib/midirec";

/**
 * MIDI 実機入力のセッション管理（#56）。マイクの recorder.ts と同じ形:
 * 開く / 後始末する / 失敗はユーザー向けメッセージで返す。
 * ノート化とトラック化は Engine 側の仕事で、ここはイベントを溜めるだけ。
 */
export type MidiInSession = {
  /** 購読中の入力ポート。表示用に名前も引ける。 */
  inputs: MIDIInput[];
  /** 受信したノートイベント（録音開始からの相対秒）。 */
  events: MidiInEvent[];
  /** 録音開始時刻（performance.now() の ms）。停止時刻もこの時間軸で取る。 */
  t0: number;
  /** 購読を外す。停止・破棄時に必ず呼ぶ。 */
  close(): void;
};

/** MIDI 入力を開いて受信を始める。失敗はユーザー向けメッセージで返す。 */
export async function openMidiIn(
  onEvent: (e: MidiInEvent) => void,
): Promise<{ midi: MidiInSession } | { error: string }> {
  if (!navigator.requestMIDIAccess) {
    return {
      error:
        "このブラウザは Web MIDI API に対応していません（Chrome / Edge / Firefox で使えます。Safari は非対応）。",
    };
  }
  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        error:
          "MIDI の使用が許可されませんでした。ブラウザのサイト設定で MIDI を許可してから、もう一度押してください。",
      };
    }
    return {
      error: `MIDI を開けませんでした: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const inputs = [...access.inputs.values()];
  if (!inputs.length) {
    return {
      error: "MIDI 入力デバイスが見つかりませんでした。キーボードを繋いでから、もう一度押してください。",
    };
  }

  const t0 = performance.now();
  const events: MidiInEvent[] = [];
  const handler = (raw: Event) => {
    const e = raw as MIDIMessageEvent;
    if (!e.data) return;
    /* MIDIMessageEvent.timeStamp は performance.now() と同じ時間軸（time origin
       起点の DOMHighResTimeStamp）なので、開始時刻との差をそのまま秒にする。
       AudioContext.currentTime に写す方式は suspend / resume でオフセットが
       ずれるので採らない。timeStamp を埋めない実装（テストのフェイク等）は
       受信時刻で代用する。 */
    const atSec = Math.max(0, ((e.timeStamp || performance.now()) - t0) / 1000);
    const ev = parseMidiMessage(e.data, atSec);
    if (!ev) return;
    events.push(ev);
    onEvent(ev);
  };
  for (const input of inputs) input.addEventListener("midimessage", handler);

  return {
    midi: {
      inputs,
      events,
      t0,
      close() {
        for (const input of inputs) input.removeEventListener("midimessage", handler);
      },
    },
  };
}
