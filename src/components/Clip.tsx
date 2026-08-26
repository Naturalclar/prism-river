import { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import { engine } from "../audio/instance";
import { CLIP_PAD, LANE_H, type TrackView } from "../audio/engine";

/**
 * 1トラック＝1クリップ。波形は Canvas に直接描く。
 * ドラッグ中は左端を DOM に直書きして、離したときだけ React とグラフを組み直す
 * （毎フレーム再レンダーするとオーディオのタイミングにノイズが乗るため）。
 */
export function Clip({ t, pxPerSec }: { t: TrackView; pxPerSec: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; off0: number; moved: boolean } | null>(null);

  const w = Math.max(1, Math.round(t.duration * pxPerSec));

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const h = LANE_H - CLIP_PAD * 2 - 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const g = canvas.getContext("2d");
    const p = engine.peaksFor(t.id, w);
    if (!g || !p) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    g.fillStyle = t.color;
    for (let x = 0; x < w; x++) {
      const up = Math.max(1, p.hi[x] * mid);
      const dn = Math.max(1, -p.lo[x] * mid);
      g.fillRect(x, mid - up, 1, up + dn);
    }
    g.globalAlpha = 0.45;
    g.fillRect(0, mid, w, 1);
  }, [t.id, t.color, w]);

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
    if (d.moved) engine.commitOffset(t.id);
  };

  return (
    <div
      ref={box}
      className={`clip${t.dimmed ? " off" : ""}`}
      style={{ "--tc": t.color, left: t.offset * pxPerSec, width: w } as CSSProperties}
      data-testid="clip"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <canvas ref={cv} />
      <div className="tag">{t.name}</div>
    </div>
  );
}
