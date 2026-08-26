import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";

const BANDS = [
  ["low", "LOW"],
  ["mid", "MID"],
  ["high", "HIGH"],
] as const;

const COMP: readonly {
  key: "threshold" | "ratio" | "attack" | "release";
  label: string;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
}[] = [
  { key: "threshold", label: "THR", min: -60, max: 0, step: 1, show: (v) => `${v} dB` },
  { key: "ratio", label: "RATIO", min: 1, max: 20, step: 0.5, show: (v) => `${v}:1` },
  { key: "attack", label: "ATK", min: 0.001, max: 0.1, step: 0.001, show: (v) => `${Math.round(v * 1000)} ms` },
  { key: "release", label: "REL", min: 0.05, max: 1, step: 0.01, show: (v) => `${Math.round(v * 1000)} ms` },
];

/**
 * 選択とは独立に、ヘッダの FX ボタンで開くトラックエフェクトのパネル。
 * パラメータは常設ノードに直結しているので、再生中でも即座に効く。
 */
export function FxPanel({ snap }: { snap: Snapshot }) {
  const t = snap.tracks.find((x) => x.id === snap.fxId);
  if (!t) return null;

  return (
    <div className="fxpanel" data-testid="fxpanel">
      <div className="fx-top">
        <b style={{ color: t.color }}>{t.name}</b>
        <span>EQ / Comp</span>
        <button
          className="tog"
          aria-label="エフェクトを閉じる"
          onClick={() => engine.toggleFxPanel(t.id)}
        >
          ✕
        </button>
      </div>

      {BANDS.map(([band, label]) => (
        <div className="head-pot" key={band}>
          <span>{label}</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={0.5}
            value={t.fx.eq[band]}
            data-testid={`fx-${band}`}
            aria-label={`${t.name} の EQ ${label}`}
            onChange={(e) => engine.setEq(t.id, band, e.currentTarget.valueAsNumber)}
          />
          <em>{t.fx.eq[band]} dB</em>
        </div>
      ))}

      <div className="fx-top">
        <button
          className="tog"
          aria-pressed={t.fx.comp.on}
          data-testid="fx-comp"
          aria-label={`${t.name} のコンプ`}
          onClick={() => engine.toggleComp(t.id)}
        >
          C
        </button>
        <span>Compressor</span>
      </div>

      {COMP.map((c) => (
        <div className="head-pot" key={c.key}>
          <span>{c.label}</span>
          <input
            type="range"
            min={c.min}
            max={c.max}
            step={c.step}
            value={t.fx.comp[c.key]}
            disabled={!t.fx.comp.on}
            data-testid={`fx-${c.key}`}
            aria-label={`${t.name} のコンプ ${c.label}`}
            onChange={(e) => engine.setComp(t.id, c.key, e.currentTarget.valueAsNumber)}
          />
          <em>{c.show(t.fx.comp[c.key])}</em>
        </div>
      ))}
    </div>
  );
}
