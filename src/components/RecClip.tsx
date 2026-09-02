import { useEffect, useRef, type CSSProperties } from "react";
import { engine } from "../audio/instance";
import { CLIP_PAD, LANE_H } from "../audio/engine";
import { takeAmpAt } from "../lib/rectake";

const WAVE_H = LANE_H - CLIP_PAD * 2 - 2;

/** canvas を広げると中身が消えるので、まとめて確保して描き直す回数を減らす。 */
const CHUNK = 512;

/**
 * 録音中の仮クリップ（#63）。停止してデコードが終わるまでトラックは現れないので、
 * そのあいだ「いま、どこに、鳴っている音が録れているか」をここで見せる。
 *
 * 毎フレーム伸びるものなので、README「作りの前提」どおり React を通さず
 * canvas と style を直に書き換える（プレイヘッド・メーターと同じ扱い）。
 *
 * 波形の正確さは狙っていない（`lib/rectake.ts` 参照）。本物の波形は停止後の
 * デコードで出るので、この表示はそのとき丸ごと差し替えて捨てる。
 */
export function RecClip({ pxPerSec }: { pxPerSec: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    /* どこまで描いたか。伸びたぶんだけ描き足す（毎フレーム全部描くと、
       長い take ほど1フレームの仕事が増えていく）。 */
    let drawn = 0;

    const paint = () => {
      const take = engine.recTakeView();
      const el = box.current;
      const c = cv.current;
      if (!take || !el || !c) return;

      el.style.left = `${take.at * pxPerSec}px`;
      const w = Math.max(1, Math.round(take.dur * pxPerSec));
      el.style.width = `${w}px`;

      if (c.width < w) {
        c.width = w + CHUNK;
        drawn = 0;
      }
      if (drawn >= w) return;

      const g = c.getContext("2d");
      if (!g) return;
      /* 枠と同じ色。--tc をテーマ変数に向けてあるので、ここで解決させる。 */
      g.fillStyle = getComputedStyle(el).borderTopColor;
      const mid = WAVE_H / 2;
      for (let x = drawn; x < w; x++) {
        const h = Math.max(1, takeAmpAt(take, x / pxPerSec) * mid);
        g.fillRect(x, mid - h, 1, h * 2);
      }
      drawn = w;
    };

    paint();
    return engine.onFrame(paint);
  }, [pxPerSec]);

  return (
    <div
      className="clip rec"
      ref={box}
      data-testid="rec-clip"
      style={{ "--tc": "var(--danger)", left: 0, width: 1 } as CSSProperties}
    >
      <canvas ref={cv} width={CHUNK} height={WAVE_H} data-testid="rec-canvas" />
      <div className="tag">録音中 …</div>
    </div>
  );
}
