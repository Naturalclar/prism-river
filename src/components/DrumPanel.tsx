import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";
import {
  BARS_MAX,
  BARS_MIN,
  BPM_MAX,
  BPM_MIN,
  DRUM_VOICES,
  PRESET_IDS,
  PRESET_LABEL,
  STEPS,
  VOICE_LABEL,
} from "../lib/drums";

/**
 * ドラムの格子（#54）。押すたびにパターンを作り直してトラックを差し替えるので、
 * 見えている格子がそのまま鳴っているものになる。
 */
export function DrumPanel({ snap }: { snap: Snapshot }) {
  const t = snap.tracks.find((x) => x.id === snap.drumsId);
  if (!t?.drums) return null;
  const p = t.drums;

  return (
    <div className="drumpanel" data-testid="drumpanel">
      <div className="fx-top">
        <b style={{ color: t.color }}>{t.name}</b>
        <span>Drums</span>
        <button
          className="tog"
          aria-label="ドラムを閉じる"
          onClick={() => engine.toggleDrumPanel(t.id)}
        >
          ✕
        </button>
      </div>

      <div className="drum-grid">
        {DRUM_VOICES.map((voice) => (
          <div className="drum-row" key={voice}>
            <span className="drum-name">{VOICE_LABEL[voice]}</span>
            {p.hits[voice].map((on, i) => (
              <button
                /* 格子の位置が識別子なので index を key にしてよい（並び替わらない）。 */
                key={i}
                className={`drum-step${on ? " on" : ""}${i % 4 === 0 ? " beat" : ""}`}
                aria-pressed={on}
                data-testid={`drum-${voice}-${i}`}
                aria-label={`${VOICE_LABEL[voice]} ${i + 1}`}
                onClick={() => engine.toggleDrumStep(t.id, voice, i)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="head-pot">
        <span>BPM</span>
        <input
          type="range"
          min={BPM_MIN}
          max={BPM_MAX}
          step={1}
          value={p.bpm}
          data-testid="drum-bpm"
          aria-label={`${t.name} の BPM`}
          onChange={(e) => engine.setDrumBpm(t.id, e.currentTarget.valueAsNumber)}
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
          data-testid="drum-bars"
          aria-label={`${t.name} の小節数`}
          onChange={(e) => engine.setDrumBars(t.id, e.currentTarget.valueAsNumber)}
        />
        <em>{p.bars}</em>
      </div>

      <div className="drum-presets">
        {PRESET_IDS.map((id) => (
          <button
            className="ghost"
            key={id}
            data-testid={`drum-preset-${id}`}
            onClick={() => engine.applyDrumPreset(t.id, id)}
          >
            {PRESET_LABEL[id]}
          </button>
        ))}
      </div>

      <small className="drum-note">
        {STEPS}ステップ＝1小節。パターンを変えるとトリムとフェードは掛け直しになる。
      </small>
    </div>
  );
}
