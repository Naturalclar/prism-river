import { voiceForGmNote, type DrumHit } from "../lib/drums";
import { DRUM_CHANNEL, midiToHz, type MidiNote, type MidiSong } from "../lib/midi";
import { renderDrumHits } from "./drums";

/**
 * 解析済み MIDI を内蔵シンセでオフラインレンダーする（#46 段1）。
 *
 * 依存ゼロ。ノートごとに OscillatorNode + ADSR の GainNode を積むだけで、
 * これは Web Audio の標準ノードで足りる範囲（HANDOFF の「WASM の領分」外）。
 * AudioBuffer にしてしまえば以降はトリム・フェード・FX・バス・書き出し・保存が
 * そのまま効く。
 */

/**
 * GM の program（0..127）をざっくり波形に割り当てる。音色の作り込みは段2。
 * 帯は 0 始まりの GM 配列に対応（Export してあるのは境界の単体テスト用）。
 */
export function waveFor(program: number): OscillatorType {
  if (program <= 7) return "triangle"; /* ピアノ系 */
  if (program <= 23) return "sine"; /* クロマチックパーカッション / オルガン */
  if (program <= 39) return "sawtooth"; /* ギター / ベース */
  if (program <= 55) return "sawtooth"; /* ストリングス / アンサンブル */
  if (program <= 79) return "square"; /* ブラス / リード楽器（Reed）/ パイプ */
  /* 80〜87 は Synth Lead。以前は下の sine に落ちていて、UI の「リード」
     （program 80）が正弦波で鳴っていた（#70）。 */
  if (program <= 87) return "square";
  return "sine"; /* パッド / FX / エスニック / パーカッシブ / SE */
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
 * チャンネル10 のノートを #54 のドラム音源で鳴らす（#58）。音色は4つしか
 * 無いので、対応の無いノート（タム類など）は鳴らさず本数だけ返す。
 */
async function renderDrumChannel(
  song: MidiSong,
  sampleRate: number,
): Promise<MidiRenderResult> {
  const t0 = performance.now();
  const hits: DrumHit[] = [];
  let skipped = 0;
  for (const n of song.notes) {
    const voice = voiceForGmNote(n.midi);
    if (!voice) {
      skipped++;
      continue;
    }
    hits.push({ voice, atSec: n.startSec, velocity: n.velocity / 127 });
  }
  const r = await renderDrumHits(hits, song.durationSec, sampleRate);
  return { buf: r.buf, ms: performance.now() - t0, rendered: hits.length, skipped };
}

/**
 * ノート列を鳴らして AudioBuffer にする。チャンネル10 だけのノート列は
 * ドラム音源へ回す（#58）。鳴らせなかった本数は呼び出し側がログに出す。
 */
export async function renderMidi(song: MidiSong, sampleRate: number): Promise<MidiRenderResult> {
  /* 呼び出し側がチャンネルごとに分けて渡すので、ここでの判定は全部か否かでよい。 */
  if (song.notes.length && song.notes.every((n) => n.channel === DRUM_CHANNEL)) {
    return renderDrumChannel(song, sampleRate);
  }
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
