import { useEffect, useRef, type RefObject } from "react";
import { engine } from "../audio/instance";

/** プレイヘッド。位置は毎フレーム変わるので transform を直に書き換える。 */
export function Needle({
  reel,
  pxPerSec,
  visible,
}: {
  reel: RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const paint = () => {
      const el = ref.current;
      if (!el) return;
      const x = engine.now() * pxPerSec - (reel.current?.scrollLeft ?? 0);
      el.style.transform = `translateX(${x}px)`;
    };
    paint();
    return engine.onFrame(paint);
  }, [reel, pxPerSec]);

  return (
    <div
      className="needle"
      ref={ref}
      data-testid="needle"
      style={{ display: visible ? "block" : "none", left: 0 }}
    />
  );
}
