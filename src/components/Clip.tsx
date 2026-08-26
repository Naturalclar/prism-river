import { useRef, type CSSProperties, type PointerEvent } from "react";
import { engine } from "../audio/instance";
import { CLIP_PAD, LANE_H, type TrackView } from "../audio/engine";
import { Tiles } from "./Tiles";

const WAVE_H = LANE_H - CLIP_PAD * 2 - 2;

/**
 * 1トラック＝1クリップ。波形は Canvas に直接描く。長尺・高ズームでは全幅が
 * canvas の一辺上限を超えるので、Tiles で分割して見えた部分だけ描く。
 * ドラッグ中は左端を DOM に直書きして、離したときだけ React とグラフを組み直す
 * （毎フレーム再レンダーするとオーディオのタイミングにノイズが乗るため）。
 */
export function Clip({ t, pxPerSec }: { t: TrackView; pxPerSec: number }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; off0: number; moved: boolean } | null>(null);

  const w = Math.max(1, Math.round(t.duration * pxPerSec));

  const paint = (g: CanvasRenderingContext2D, x0: number, tw: number) => {
    const p = engine.peaksFor(t.id, w);
    if (!p) return;
    const mid = WAVE_H / 2;
    const end = Math.min(w, x0 + tw);
    g.fillStyle = t.color;
    for (let x = x0; x < end; x++) {
      const up = Math.max(1, p.hi[x] * mid);
      const dn = Math.max(1, -p.lo[x] * mid);
      g.fillRect(x, mid - up, 1, up + dn);
    }
    g.globalAlpha = 0.45;
    g.fillRect(x0, mid, end - x0, 1);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x0: e.clientX, off0: t.offset, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("dragging");
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    if (Math.abs(e.clientX - d.x0) > 2) d.moved = true;
    const off = Math.max(0, d.off0 + (e.clientX - d.x0) / pxPerSec);
    engine.nudgeOffset(t.id, off);
    if (box.current) box.current.style.left = `${off * pxPerSec}px`;
    engine.emitFrame();
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    e.currentTarget.releasePointerCapture(d.id);
    e.currentTarget.classList.remove("dragging");
    drag.current = null;
    if (d.moved) {
      engine.commitOffset(t.id);
    } else {
      /* 動かさずに離した＝クリック。選択のトグルにする。 */
      engine.select(t.selected ? null : t.id);
    }
  };

  return (
    <div
      ref={box}
      className={`clip${t.dimmed ? " off" : ""}${t.selected ? " selected" : ""}`}
      style={{ "--tc": t.color, left: t.offset * pxPerSec, width: w } as CSSProperties}
      data-testid="clip"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="wave">
        <Tiles width={w} height={WAVE_H} paint={paint} deps={[t.id, t.color, w]} />
      </div>
      <div className="tag">{t.name}</div>
    </div>
  );
}
