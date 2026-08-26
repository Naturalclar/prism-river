import { useEffect, useRef } from "react";
import { engine } from "../audio/instance";

/** L/R のレベルメーター。これも毎フレーム更新なので DOM を直に触る。 */
export function Meters() {
  const l = useRef<HTMLElement>(null);
  const r = useRef<HTMLElement>(null);

  useEffect(
    () =>
      engine.onFrame(() => {
        const [L, R] = engine.levels();
        for (const [el, v] of [
          [l.current, L],
          [r.current, R],
        ] as const) {
          if (!el) continue;
          el.style.width = `${Math.min(100, v * 180)}%`;
          el.classList.toggle("hot", v > 0.7);
        }
      }),
    [],
  );

  return (
    <div className="meter" aria-hidden="true">
      <span>
        <i ref={l} />
      </span>
      <span>
        <i ref={r} />
      </span>
    </div>
  );
}
