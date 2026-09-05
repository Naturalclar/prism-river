import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { engine } from "../audio/instance";
import type { LoopRange } from "../lib/loop";
import { clamp, pickRulerStep, rulerLabel, rulerSubdivisions } from "../lib/time";
import { Tiles } from "./Tiles";

const H = 30;
/** これ以下の移動はクリック（＝シーク）と見なす。指のぶれで区間を作らないため。 */
const DRAG_PX = 3;

export function Ruler({
  width,
  pxPerSec,
  loop,
}: {
  width: number;
  pxPerSec: number;
  loop: LoopRange | null;
}) {
  /* 目盛りの色はテーマ由来なので、切り替わったら世代を上げてタイルを描き直させる。 */
  const [themeGen, setThemeGen] = useState(0);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setThemeGen((g) => g + 1);
    mq.addEventListener("change", bump);
    return () => mq.removeEventListener("change", bump);
  }, []);

  /* ループ区間のドラッグ（#88）。クリップの移動・トリムと同じで、ドラッグ中は
     React を挟まず帯の style を直に書き、離したときだけ Engine に渡す。 */
  const band = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; from: number; to: number; moved: boolean } | null>(null);

  const paint = (g: CanvasRenderingContext2D, x0: number, tw: number) => {
    const css = getComputedStyle(document.body);
    const faint = css.getPropertyValue("--text-faint").trim();
    const line = css.getPropertyValue("--line-strong").trim();
    const step = pickRulerStep(pxPerSec);
    const subs = rulerSubdivisions(step);

    g.font = '500 10px "IBM Plex Mono", monospace';
    g.textBaseline = "alphabetic";
    /* タイル左端にかかる前のラベル（幅 60px ほど）も描けるよう 80px ぶん戻って始める。 */
    const i0 = Math.max(0, Math.floor((x0 - 80) / (step * pxPerSec)));
    for (let i = i0; i * step * pxPerSec <= x0 + tw; i++) {
      const s = i * step;
      const x = Math.round(s * pxPerSec) + 0.5;
      g.strokeStyle = line;
      g.beginPath();
      g.moveTo(x, 18);
      g.lineTo(x, H);
      g.stroke();
      g.fillStyle = faint;
      g.fillText(rulerLabel(s, step), x + 4, 14);

      const sub = step / subs;
      for (let k = 1; k < subs; k++) {
        const xx = Math.round((s + sub * k) * pxPerSec) + 0.5;
        if (xx > width) break;
        g.strokeStyle = line;
        g.globalAlpha = 0.5;
        g.beginPath();
        g.moveTo(xx, 24);
        g.lineTo(xx, H);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
  };

  /** ドラッグ中の仮表示。確定するまで Engine には入れない。 */
  const preview = (from: number, to: number) => {
    const el = band.current;
    if (!el) return;
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    el.style.display = "block";
    el.style.left = `${a * pxPerSec}px`;
    el.style.width = `${(b - a) * pxPerSec}px`;
  };

  /**
   * 仮表示を今の区間（＝React が持っている値）へ戻す。
   * 区間なし → 短すぎる指定 → 区間なし、のように props が変わらない遷移では
   * React が style を書き直さないので、直書きした分は自分で畳む必要がある。
   */
  const restore = () => {
    const el = band.current;
    if (!el) return;
    if (loop) {
      el.style.display = "block";
      el.style.left = `${loop.start * pxPerSec}px`;
      el.style.width = `${(loop.end - loop.start) * pxPerSec}px`;
    } else {
      el.style.display = "none";
    }
  };

  const secAt = (e: ReactPointerEvent, el: HTMLElement) =>
    (e.clientX - el.getBoundingClientRect().left) / pxPerSec;

  return (
    <div
      className="ruler"
      style={{ width }}
      data-testid="ruler"
      onPointerDown={(e) => {
        /* ×（区間の解除）はボタン自身に任せる。 */
        if ((e.target as Element).closest(".loop-x")) return;
        const at = engine.snapTime(secAt(e, e.currentTarget), !e.shiftKey);
        drag.current = { x0: e.clientX, from: at, to: at, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
        d.moved = true;
        d.to = engine.snapTime(secAt(e, e.currentTarget), !e.shiftKey);
        preview(d.from, d.to);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        /* 動いていなければ今までどおりのシーク。区間には触らない。 */
        if (!d.moved) {
          engine.seek(clamp(secAt(e, e.currentTarget), 0, engine.total()));
          return;
        }
        if (!engine.setLoop(d.from, d.to)) restore();
      }}
      onPointerCancel={() => {
        drag.current = null;
        restore();
      }}
    >
      <Tiles width={width} height={H} paint={paint} deps={[width, pxPerSec, themeGen]} />

      {/* 帯はドラッグ中も出るので、区間が無いときは display:none で置いておく。 */}
      <div
        className="loop-band"
        data-testid="loop-band"
        ref={band}
        style={
          loop
            ? {
                display: "block",
                left: loop.start * pxPerSec,
                width: (loop.end - loop.start) * pxPerSec,
              }
            : { display: "none" }
        }
      >
        {loop && (
          <button
            type="button"
            className="loop-x"
            data-testid="loop-clear"
            title="ループ範囲を解除"
            aria-label="ループ範囲を解除"
            onClick={() => engine.clearLoop()}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
