import { useEffect, useState } from "react";
import { engine } from "../audio/instance";
import { clamp, pickRulerStep, rulerLabel, rulerSubdivisions } from "../lib/time";
import { Tiles } from "./Tiles";

const H = 30;

export function Ruler({ width, pxPerSec }: { width: number; pxPerSec: number }) {
  /* 目盛りの色はテーマ由来なので、切り替わったら世代を上げてタイルを描き直させる。 */
  const [themeGen, setThemeGen] = useState(0);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setThemeGen((g) => g + 1);
    mq.addEventListener("change", bump);
    return () => mq.removeEventListener("change", bump);
  }, []);

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

  return (
    <div
      className="ruler"
      style={{ width }}
      data-testid="ruler"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        engine.seek(clamp((e.clientX - r.left) / pxPerSec, 0, engine.total()));
      }}
    >
      <Tiles width={width} height={H} paint={paint} deps={[width, pxPerSec, themeGen]} />
    </div>
  );
}
