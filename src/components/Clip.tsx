import { useRef, type CSSProperties, type PointerEvent } from "react";
import { engine } from "../audio/instance";
import { CLIP_PAD, LANE_H, type TrackView } from "../audio/engine";
import { Tiles } from "./Tiles";

const WAVE_H = LANE_H - CLIP_PAD * 2 - 2;

/** move＝クリップの移動、start / end＝左右端のトリム。 */
type DragMode = "move" | "start" | "end";

type Drag = {
  id: number;
  x0: number;
  mode: DragMode;
  off0: number;
  ts0: number;
  dur0: number;
  moved: boolean;
};

/**
 * 1トラック＝1クリップ。波形は Canvas に直接描く。長尺・高ズームでは全幅が
 * canvas の一辺上限を超えるので、Tiles で分割して見えた部分だけ描く。
 * ドラッグ（移動もトリムも）中は DOM を直書きして、離したときだけ React と
 * グラフを組み直す（毎フレーム再レンダーするとオーディオのタイミングに
 * ノイズが乗るため）。
 */
export function Clip({ t, pxPerSec }: { t: TrackView; pxPerSec: number }) {
  const box = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

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

  const start = (e: PointerEvent<HTMLElement>, mode: DragMode) => {
    if (e.button !== 0) return;
    /* グリップからの down はクリップ本体の移動ドラッグを始めない。 */
    if (mode !== "move") e.stopPropagation();
    const b = box.current;
    if (!b) return;
    drag.current = { id: e.pointerId, x0: e.clientX, mode, off0: t.offset, ts0: t.trimStart, dur0: t.duration, moved: false };
    b.setPointerCapture(e.pointerId);
    b.classList.add("dragging");
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const b = box.current;
    if (!d || e.pointerId !== d.id || !b) return;
    const dx = e.clientX - d.x0;
    if (Math.abs(dx) > 2) d.moved = true;

    if (d.mode === "move") {
      const off = Math.max(0, d.off0 + dx / pxPerSec);
      engine.nudgeOffset(t.id, off);
      b.style.left = `${off * pxPerSec}px`;
    } else if (d.mode === "start") {
      const r = engine.trimTo(t.id, "start", d.ts0 + dx / pxPerSec);
      if (r) {
        b.style.left = `${r.offset * pxPerSec}px`;
        b.style.width = `${Math.max(1, Math.round(r.duration * pxPerSec))}px`;
        /* 波形は画面上の位置を保つ。左端が波形を「削って」いくように見せる。 */
        if (wave.current)
          wave.current.style.transform = `translateX(${-(r.trimStart - d.ts0) * pxPerSec}px)`;
      }
    } else {
      const r = engine.trimTo(t.id, "end", d.ts0 + d.dur0 + dx / pxPerSec);
      if (r) b.style.width = `${Math.max(1, Math.round(r.duration * pxPerSec))}px`;
    }
    engine.emitFrame();
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    box.current?.releasePointerCapture(d.id);
    box.current?.classList.remove("dragging");
    if (wave.current) wave.current.style.transform = "";
    drag.current = null;
    if (!d.moved) {
      /* 動かさずに離した＝クリック。本体なら選択のトグル、グリップなら何もしない。 */
      if (d.mode === "move") engine.select(t.selected ? null : t.id);
      return;
    }
    if (d.mode === "move") engine.commitOffset(t.id);
    else engine.commitTrim(t.id);
  };

  return (
    <div
      ref={box}
      className={`clip${t.dimmed ? " off" : ""}${t.selected ? " selected" : ""}`}
      style={{ "--tc": t.color, left: t.offset * pxPerSec, width: w } as CSSProperties}
      data-testid="clip"
      onPointerDown={(e) => start(e, "move")}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="wave" ref={wave}>
        <Tiles width={w} height={WAVE_H} paint={paint} deps={[t.id, t.color, w]} />
      </div>
      <div className="grip l" data-testid="grip-l" onPointerDown={(e) => start(e, "start")} />
      <div className="grip r" data-testid="grip-r" onPointerDown={(e) => start(e, "end")} />
      <div className="tag">{t.name}</div>
    </div>
  );
}
