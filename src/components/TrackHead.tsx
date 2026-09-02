import type { CSSProperties } from "react";
import { engine } from "../audio/instance";
import { BUS_IDS, BUS_INFO, type TrackView } from "../audio/engine";
import { panLabel } from "../lib/time";

export function TrackHead({
  t,
  fxOpen,
  drumsOpen,
  rollOpen,
}: {
  t: TrackView;
  fxOpen: boolean;
  drumsOpen: boolean;
  rollOpen: boolean;
}) {
  return (
    <div
      className={`head${t.selected ? " selected" : ""}`}
      style={{ "--tc": t.color } as CSSProperties}
      data-testid="track-head"
      onClick={(e) => {
        /* S / M / ✕ やスライダーの操作では選択を動かさない。 */
        if ((e.target as Element).closest("button, input")) return;
        engine.select(t.selected ? null : t.id);
      }}
    >
      <div className="head-row">
        <div className="head-name" title={t.name}>
          {t.name}
        </div>
        <button
          className="tog"
          aria-pressed={t.solo}
          title="ソロ"
          aria-label={`${t.name} をソロ`}
          onClick={() => engine.toggleSolo(t.id)}
        >
          S
        </button>
        <button
          className="tog x"
          aria-pressed={t.mute}
          title="ミュート"
          aria-label={`${t.name} をミュート`}
          onClick={() => engine.toggleMute(t.id)}
        >
          M
        </button>
        <button
          className="tog"
          aria-pressed={fxOpen}
          title="エフェクト (EQ / コンプ)"
          aria-label={`${t.name} のエフェクト`}
          onClick={() => engine.toggleFxPanel(t.id)}
        >
          FX
        </button>
        {/* ドラムトラックだけ格子を開き直せるようにする（#54）。 */}
        {t.drums && (
          <button
            className="tog"
            aria-pressed={drumsOpen}
            title="ドラムパターン"
            aria-label={`${t.name} のドラム`}
            onClick={() => engine.toggleDrumPanel(t.id)}
          >
            D
          </button>
        )}
        {/* 打ち込みトラックだけロールを開き直せるようにする（#55）。 */}
        {t.roll && (
          <button
            className="tog"
            aria-pressed={rollOpen}
            title="ピアノロール"
            aria-label={`${t.name} のロール`}
            onClick={() => engine.toggleRollPanel(t.id)}
          >
            R
          </button>
        )}
        <button
          className="tog"
          title="削除"
          aria-label={`${t.name} を削除`}
          style={{ borderColor: "transparent" }}
          onClick={() => engine.remove(t.id)}
        >
          ✕
        </button>
      </div>

      {/* グループバスの割り当て。もう一度押すと外れて Master 直結に戻る。 */}
      <div className="bus-pick" role="group" aria-label={`${t.name} のバス`}>
        {BUS_IDS.map((b) => (
          <button
            key={b}
            className="bus-seg"
            style={{ "--bc": BUS_INFO[b].color } as CSSProperties}
            aria-pressed={t.bus === b}
            title={`${BUS_INFO[b].label}バス（${BUS_INFO[b].sister}）`}
            aria-label={`${t.name} を${BUS_INFO[b].label}バスへ`}
            data-testid={`bus-${b}`}
            onClick={() => engine.setBus(t.id, t.bus === b ? null : b)}
          >
            {BUS_INFO[b].label}
          </button>
        ))}
      </div>

      <div className="head-pot">
        <span>VOL</span>
        <input
          type="range"
          min={0}
          max={1.4}
          step={0.01}
          value={t.vol}
          aria-label={`${t.name} の音量`}
          onChange={(e) => engine.setVol(t.id, e.currentTarget.valueAsNumber)}
        />
        <em>{Math.round(t.vol * 100)}</em>
      </div>

      <div className="head-pot">
        <span>PAN</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.02}
          value={t.panv}
          aria-label={`${t.name} のパン`}
          onChange={(e) => engine.setPan(t.id, e.currentTarget.valueAsNumber)}
        />
        <em>{panLabel(t.panv)}</em>
      </div>
    </div>
  );
}
