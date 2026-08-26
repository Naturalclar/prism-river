import { useEffect, useRef } from "react";
import { engine } from "../audio/instance";
import { clamp, pickRulerStep, rulerLabel, rulerSubdivisions } from "../lib/time";

const H = 30;

export function Ruler({ width, pxPerSec }: { width: number; pxPerSec: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = H * dpr;
    cv.style.width = `${width}px`;
    cv.style.height = `${H}px`;
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, H);

    const css = getComputedStyle(document.body);
    const faint = css.getPropertyValue("--text-faint").trim();
    const line = css.getPropertyValue("--line-strong").trim();
    const step = pickRulerStep(pxPerSec);
    const subs = rulerSubdivisions(step);

    g.font = '500 10px "IBM Plex Mono", monospace';
    g.textBaseline = "alphabetic";
    for (let s = 0; s * pxPerSec <= width; s += step) {
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
  }, [width, pxPerSec]);

  return (
    <canvas
      className="ruler"
      ref={ref}
      data-testid="ruler"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        engine.seek(clamp((e.clientX - r.left) / pxPerSec, 0, engine.total()));
      }}
    />
  );
}
