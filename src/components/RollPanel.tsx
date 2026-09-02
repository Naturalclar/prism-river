import { useState } from "react";
import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";
import { BARS_MAX, BARS_MIN, BPM_MAX, BPM_MIN } from "../lib/grid";
import {
  isBlackKey,
  midiForRow,
  noteName,
  rollSteps,
  NOTE_LENGTHS,
  OCTAVE_MAX,
  OCTAVE_MIN,
  ROLL_ROWS,
  TONES,
  type NoteLength,
} from "../lib/pianoroll";

/**
 * ピアノロール（#55）。押すたびにノート列を作り直してトラックを差し替えるので、
 * 見えている格子がそのまま鳴っているものになる（ドラム #54 と同じ流儀）。
 *
 * ドラムの格子と違い、小節は繰り返さず横に伸びる——メロディは小節ごとに
 * 中身が変わるため。
 */
export function RollPanel({ snap }: { snap: Snapshot }) {
  /* 置く音の長さ。ドラッグでの伸縮は範囲外なので、選んでから置く形にする。 */
  const [len, setLen] = useState<NoteLength>(2);
  const t = snap.tracks.find((x) => x.id === snap.rollId);
  if (!t?.roll) return null;
  const p = t.roll;
  const steps = rollSteps(p);
  /* 上から下へ高い音→低い音。格子の行番号は下が 0。 */
  const rows = Array.from({ length: ROLL_ROWS }, (_, i) => ROLL_ROWS - 1 - i);

  return (
    <div className="rollpanel" data-testid="rollpanel">
      <div className="fx-top">
        <b style={{ color: t.color }}>{t.name}</b>
        <span>Piano roll</span>
        <button
          className="tog"
          aria-label="ピアノロールを閉じる"
          onClick={() => engine.toggleRollPanel(t.id)}
        >
          ✕
        </button>
      </div>

      <div className="roll-grid">
        {rows.map((row) => {
          const midi = midiForRow(row, p.octave);
          return (
            <div className={`roll-row${isBlackKey(midi) ? " black" : ""}`} key={row}>
              <span className="roll-key">{noteName(midi)}</span>
              {Array.from({ length: steps }, (_, step) => {
                const on = p.notes.some((n) => n.midi === midi && n.step === step);
                /* 音の続きの部分。押せるのは頭だけにして、消し方を1つに保つ。 */
                const held = p.notes.some(
                  (n) => n.midi === midi && n.step < step && n.step + n.len > step,
                );
                return (
                  <button
                    key={step}
                    className={`roll-cell${on ? " on" : held ? " held" : ""}${step % 4 === 0 ? " beat" : ""}`}
                    aria-pressed={on}
                    data-testid={`roll-${midi}-${step}`}
                    aria-label={`${noteName(midi)} ステップ${step + 1}`}
                    onClick={() => engine.toggleRollNote(t.id, step, midi, len)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="roll-controls">
        <div className="head-pot">
          <span>長さ</span>
          <div className="roll-lens">
            {NOTE_LENGTHS.map((n) => (
              <button
                className={`tog${len === n ? " on" : ""}`}
                key={n}
                aria-pressed={len === n}
                data-testid={`roll-len-${n}`}
                aria-label={`置く音の長さ ${n}`}
                onClick={() => setLen(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="head-pot">
          <span>音色</span>
          <div className="roll-lens">
            {TONES.map((tone) => (
              <button
                className={`tog${p.program === tone.program ? " on" : ""}`}
                key={tone.program}
                aria-pressed={p.program === tone.program}
                data-testid={`roll-tone-${tone.program}`}
                onClick={() => engine.setRollProgram(t.id, tone.program)}
              >
                {tone.label}
              </button>
            ))}
          </div>
        </div>

        <div className="head-pot">
          <span>BPM</span>
          <input
            type="range"
            min={BPM_MIN}
            max={BPM_MAX}
            step={1}
            value={p.bpm}
            data-testid="roll-bpm"
            aria-label={`${t.name} の BPM`}
            onChange={(e) => engine.setRollBpm(t.id, e.currentTarget.valueAsNumber)}
          />
          <em>{p.bpm}</em>
        </div>

        <div className="head-pot">
          <span>小節</span>
          <input
            type="range"
            min={BARS_MIN}
            max={BARS_MAX}
            step={1}
            value={p.bars}
            data-testid="roll-bars"
            aria-label={`${t.name} の小節数`}
            onChange={(e) => engine.setRollBars(t.id, e.currentTarget.valueAsNumber)}
          />
          <em>{p.bars}</em>
        </div>

        <div className="head-pot">
          <span>オクターブ</span>
          <input
            type="range"
            min={OCTAVE_MIN}
            max={OCTAVE_MAX}
            step={1}
            value={p.octave}
            data-testid="roll-octave"
            aria-label={`${t.name} の表示オクターブ`}
            onChange={(e) => engine.setRollOctave(t.id, e.currentTarget.valueAsNumber)}
          />
          <em>{p.octave > 0 ? `+${p.octave}` : p.octave}</em>
        </div>

        <button className="ghost" data-testid="roll-clear" onClick={() => engine.clearRoll(t.id)}>
          クリア
        </button>
      </div>

      <small className="drum-note">
        小節は繰り返さず横に伸びる。オクターブは表示位置だけを動かすので、置いた音は動かない。
      </small>
    </div>
  );
}
