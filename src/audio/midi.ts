import { DRUM_CHANNEL, midiToHz, type MidiNote, type MidiSong } from "../lib/midi";

/**
 * 解析済み MIDI を内蔵シンセでオフラインレンダーする（#46 段1）。
 *
 * 依存ゼロ。ノートごとに OscillatorNode + ADSR の GainNode を積むだけで、
 * これは Web Audio の標準ノードで足りる範囲（HANDOFF の「WASM の領分」外）。
 * AudioBuffer にしてしまえば以降はトリム・フェード・FX・バス・書き出し・保存が
 * そのまま効く。
 */

/** GM の program（0..127）をざっくり波形に割り当てる。音色の作り込みは段2。 */
function waveFor(program: number): OscillatorType {
  if (program <= 7) return "triangle"; /* ピアノ系 */
  if (program <= 23) return "sine"; /* クロマチックパーカッション / オルガン */
  if (program <= 39) return "sawtooth"; /* ギター / ベース */
  if (program <= 55) return "sawtooth"; /* ストリングス / アンサンブル */
  if (program <= 79) return "square"; /* ブラス / リード / パイプ */
  return "sine";
}

/** 音の立ち上がり / 減衰（秒）。短い音でも切れないよう長さに合わせて詰める。 */
function envelopeOf(durSec: number): { attack: number; release: number } {
  const attack = Math.min(0.01, durSec / 4);
  const release = Math.min(0.12, durSec / 2);
  return { attack, release };
}

/**
 * 同時発音数からマスターゲインを決める。和音でクリップさせないための粗い正規化
 * （厳密なリミッタではない）。
 */
function masterGainFor(notes: MidiNote[]): number {
  let peak = 1;
  const ends: number[] = [];
  for (const n of notes) {
    /* 同時に鳴っている本数の最大値。ノートは開始順に並んでいる前提。 */
    for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= n.startSec) ends.splice(i, 1);
    ends.push(n.startSec + n.durSec);
    peak = Math.max(peak, ends.length);
  }
  return 1 / Math.sqrt(peak);
}

export type MidiRenderResult = { buf: AudioBuffer; ms: number; rendered: number; skipped: number };

/**
 * ノート列を鳴らして AudioBuffer にする。ドラム（チャンネル10）は段1では
 * 音源が無いので鳴らさず、本数を返して呼び出し側がログに出せるようにする。
 */
export async function renderMidi(song: MidiSong, sampleRate: number): Promise<MidiRenderResult> {
  const play = song.notes.filter((n) => n.channel !== DRUM_CHANNEL);
  const skipped = song.notes.length - play.length;
  const t0 = performance.now();

  /* エンベロープは最後のノートの終端でちょうど 0 に落ちるので、余白は要らない
     （足すとクリップの長さが曲より延びて、トリムや全長表示がずれる）。 */
  const off = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(song.durationSec * sampleRate)),
    sampleRate,
  );
  const master = off.createGain();
  master.gain.value = masterGainFor(play);
  master.connect(off.destination);

  for (const n of play) {
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = waveFor(n.program);
    osc.frequency.value = midiToHz(n.midi);
    osc.connect(g);
    g.connect(master);

    const level = (n.velocity / 127) * 0.8;
    const { attack, release } = envelopeOf(n.durSec);
    const start = n.startSec;
    const end = start + n.durSec;
    /* 直線の折れ線だけで書く。setTargetAtTime と違い、どの時刻の値も予約済みの
       スケジュールから決まる（AudioParam.value は現在値であって予約値ではない）。 */
    const decayAt = Math.max(start + attack, end - release);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(level, start + attack);
    /* サステインは軽く落とす。ずっと同じ音量だとオルガンのように聞こえる。 */
    g.gain.linearRampToValueAtTime(level * 0.7, decayAt);
    g.gain.linearRampToValueAtTime(0, end);
    osc.start(start);
    osc.stop(end + 0.01);
  }

  const buf = await off.startRendering();
  return { buf, ms: performance.now() - t0, rendered: play.length, skipped };
}
