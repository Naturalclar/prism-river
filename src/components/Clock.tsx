import { useEffect, useRef } from "react";
import { engine } from "../audio/instance";
import { formatTime } from "../lib/time";

/**
 * 現在位置と全長。毎フレーム動くので React の state は経由せず、
 * textContent を直に書き換える。
 */
export function Clock() {
  const pos = useRef<HTMLElement>(null);
  const len = useRef<HTMLElement>(null);

  useEffect(
    () =>
      engine.onFrame(() => {
        if (pos.current) pos.current.textContent = formatTime(engine.now());
        if (len.current) len.current.textContent = `/ ${formatTime(engine.total())}`;
      }),
    [],
  );

  return (
    <div className="clock mono">
      <b ref={pos} data-testid="clock-pos">
        00:00.00
      </b>{" "}
      <i ref={len}>/ 00:00.00</i>
    </div>
  );
}
