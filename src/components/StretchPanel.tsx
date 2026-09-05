import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";
import {
  NO_STRETCH,
  SEMITONE_MAX,
  SEMITONE_MIN,
  TEMPO_MAX,
  TEMPO_MIN,
  type StretchParams,
} from "../lib/stretch";

/** よく使う倍率。練習用に遅くするのが主な用途なので、遅い側を厚めに置く。 */
const TEMPO_PRESETS = [0.5, 0.75, 0.9, 1, 1.25, 1.5];

const semiLabel = (n: number) => (n === 0 ? "±0" : `${n > 0 ? "+" : ""}${n}`);

/**
 * ヘッダの TS ボタンで開くタイムストレッチのパネル（#25）。
 *
 * 掛け直しはそのつど WASM（Rubber Band）を回すオフライン処理なので、
 * スライダーは `onChange`（離したとき）で確定させる。`onInput` で追うと
 * ドラッグ中ずっとレンダーが走る。
 */
export function StretchPanel({ snap }: { snap: Snapshot }) {
  const t = snap.tracks.find((x) => x.id === snap.stretchId);
  if (!t) return null;

  const cur: StretchParams = t.stretch ?? NO_STRETCH;
  const set = (p: Partial<StretchParams>) => void engine.setStretch(t.id, { ...cur, ...p });

  return (
    <div className="fxpanel stretchpanel" data-testid="stretchpanel">
      <div className="fx-top">
        <b style={{ color: t.color }}>{t.name}</b>
        <span>Time / Pitch</span>
        <button
          className="tog"
          aria-label="ストレッチを閉じる"
          onClick={() => engine.toggleStretchPanel(t.id)}
        >
          ✕
        </button>
      </div>

      <div className="head-pot">
        <span>TEMPO</span>
        <input
          type="range"
          min={TEMPO_MIN}
          max={TEMPO_MAX}
          step={0.05}
          value={cur.tempo}
          disabled={t.stretching}
          data-testid="stretch-tempo"
          aria-label={`${t.name} のテンポ`}
          onChange={(e) => set({ tempo: e.currentTarget.valueAsNumber })}
        />
        <em data-testid="stretch-tempo-val">{cur.tempo.toFixed(2)}x</em>
      </div>

      <div className="seg-row" role="group" aria-label={`${t.name} のテンポプリセット`}>
        {TEMPO_PRESETS.map((v) => (
          <button
            key={v}
            className="ghost"
            aria-pressed={cur.tempo === v}
            disabled={t.stretching}
            data-testid={`stretch-tempo-${v}`}
            onClick={() => set({ tempo: v })}
          >
            {v}x
          </button>
        ))}
      </div>

      <div className="head-pot">
        <span>PITCH</span>
        <input
          type="range"
          min={SEMITONE_MIN}
          max={SEMITONE_MAX}
          step={1}
          value={cur.semitones}
          disabled={t.stretching}
          data-testid="stretch-pitch"
          aria-label={`${t.name} のピッチ`}
          onChange={(e) => set({ semitones: e.currentTarget.valueAsNumber })}
        />
        <em data-testid="stretch-pitch-val">{semiLabel(cur.semitones)} 半音</em>
      </div>

      <div className="seg-row">
        <button
          className="ghost"
          disabled={t.stretching}
          data-testid="stretch-reset"
          onClick={() => set(NO_STRETCH)}
        >
          等倍に戻す
        </button>
        {/* 掛け直しは尺に比例して時間がかかる。押せない理由が分かるようにする。 */}
        <span className="fx-note">{t.stretching ? "計算中…" : "テンポとピッチは独立"}</span>
      </div>
    </div>
  );
}
