import { useRef, type CSSProperties, type PointerEvent } from "react";
import { engine } from "../audio/instance";
import { CLIP_PAD, LANE_H, type TrackView } from "../audio/engine";
import { clampFades } from "../lib/fade";
import { Tiles } from "./Tiles";

const WAVE_H = LANE_H - CLIP_PAD * 2 - 2;

/** move＝移動、start / end＝左右端のトリム、fadeIn / fadeOut＝上端のフェード。 */
type DragMode = "move" | "start" | "end" | "fadeIn" | "fadeOut";

type Drag = {
  id: number;
  x0: number;
  mode: DragMode;
  off0: number;
  ts0: number;
  dur0: number;
  fi0: number;
  fo0: number;
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
  const fadeL = useRef<{ handle: HTMLDivElement | null; shade: HTMLDivElement | null }>({ handle: null, shade: null });
  const fadeR = useRef<{ handle: HTMLDivElement | null; shade: HTMLDivElement | null }>({ handle: null, shade: null });
  const drag = useRef<Drag | null>(null);

  const w = Math.max(1, Math.round(t.duration * pxPerSec));
  /* トリムで縮んだ直後は保存値が実効長を超え得るので、表示は詰めた値で。 */
  const { fi, fo } = clampFades(t.duration, t.fadeIn, t.fadeOut);

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
    drag.current = { id: e.pointerId, x0: e.clientX, mode, off0: t.offset, ts0: t.trimStart, dur0: t.duration, fi0: fi, fo0: fo, moved: false };
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
      /* Shift ドラッグはスナップを切る（微調整用）。吸着中は枠色で知らせる。 */
      const r = engine.nudgeOffset(t.id, d.off0 + dx / pxPerSec, !e.shiftKey);
      if (r) {
        b.style.left = `${r.offset * pxPerSec}px`;
        b.classList.toggle("snapped", r.snapped);
      }
    } else if (d.mode === "start") {
      const r = engine.trimTo(t.id, "start", d.ts0 + dx / pxPerSec);
      if (r) {
        b.style.left = `${r.offset * pxPerSec}px`;
        b.style.width = `${Math.max(1, Math.round(r.duration * pxPerSec))}px`;
        /* 波形は画面上の位置を保つ。左端が波形を「削って」いくように見せる。 */
        if (wave.current)
          wave.current.style.transform = `translateX(${-(r.trimStart - d.ts0) * pxPerSec}px)`;
      }
    } else if (d.mode === "end") {
      const r = engine.trimTo(t.id, "end", d.ts0 + d.dur0 + dx / pxPerSec);
      if (r) b.style.width = `${Math.max(1, Math.round(r.duration * pxPerSec))}px`;
    } else if (d.mode === "fadeIn") {
      const r = engine.fadeTo(t.id, "in", d.fi0 + dx / pxPerSec);
      if (r) {
        const px = r.fadeIn * pxPerSec;
        if (fadeL.current.handle) fadeL.current.handle.style.left = `${px - 5}px`;
        if (fadeL.current.shade) fadeL.current.shade.style.width = `${px}px`;
      }
    } else {
      const r = engine.fadeTo(t.id, "out", d.fo0 - dx / pxPerSec);
      if (r) {
        const px = r.fadeOut * pxPerSec;
        if (fadeR.current.handle) fadeR.current.handle.style.right = `${px - 5}px`;
        if (fadeR.current.shade) fadeR.current.shade.style.width = `${px}px`;
      }
    }
    engine.emitFrame();
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    box.current?.releasePointerCapture(d.id);
    box.current?.classList.remove("dragging", "snapped");
    if (wave.current) wave.current.style.transform = "";
    drag.current = null;
    if (!d.moved) {
      /* 動かさずに離した＝クリック。本体なら選択のトグル、グリップなら何もしない。 */
      if (d.mode === "move") engine.select(t.selected ? null : t.id);
      return;
    }
    if (d.mode === "move") engine.commitOffset(t.id);
    else if (d.mode === "fadeIn" || d.mode === "fadeOut") engine.commitFade(t.id);
    else engine.commitTrim(t.id);
  };

  return (
    <div
      ref={box}
      className={`clip${t.dimmed ? " off" : ""}${t.selected ? " selected" : ""}`}
      style={{ "--tc": t.color, left: t.offset * pxPerSec, width: w } as CSSProperties}
      data-testid="clip"
      data-track-id={t.id}
      onPointerDown={(e) => start(e, "move")}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="wave" ref={wave}>
        <Tiles width={w} height={WAVE_H} paint={paint} deps={[t.id, t.color, w]} />
      </div>
      <div
        className="fade-shade l"
        ref={(el) => void (fadeL.current.shade = el)}
        style={{ width: fi * pxPerSec }}
      />
      <div
        className="fade-shade r"
        ref={(el) => void (fadeR.current.shade = el)}
        style={{ width: fo * pxPerSec }}
      />
      <div className="grip l" data-testid="grip-l" onPointerDown={(e) => start(e, "start")} />
      <div className="grip r" data-testid="grip-r" onPointerDown={(e) => start(e, "end")} />
      <div
        className="fade-handle l"
        data-testid="fade-l"
        ref={(el) => void (fadeL.current.handle = el)}
        style={{ left: fi * pxPerSec - 5 }}
        onPointerDown={(e) => start(e, "fadeIn")}
      />
      <div
        className="fade-handle r"
        data-testid="fade-r"
        ref={(el) => void (fadeR.current.handle = el)}
        style={{ right: fo * pxPerSec - 5 }}
        onPointerDown={(e) => start(e, "fadeOut")}
      />
      <div className="tag">{t.name}</div>
    </div>
  );
}
