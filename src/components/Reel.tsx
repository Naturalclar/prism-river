import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";
import { Clip } from "./Clip";
import { Needle } from "./Needle";
import { Ruler } from "./Ruler";

export function Reel({ snap }: { snap: Snapshot }) {
  const reel = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);

  useLayoutEffect(() => {
    const el = reel.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /* ズームを変えたら、変更前に見ていた位置が画面中央に来るように追従する。 */
  const zoomAnchor = useRef(snap.pxPerSec);
  useEffect(() => {
    if (zoomAnchor.current === snap.pxPerSec) return;
    zoomAnchor.current = snap.pxPerSec;
    const el = reel.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, engine.now() * snap.pxPerSec - el.clientWidth / 2);
  }, [snap.pxPerSec]);

  const width = Math.max(viewW, Math.ceil(snap.duration * snap.pxPerSec) + 240);

  return (
    <div
      className="reel"
      ref={reel}
      data-testid="reel"
      onScroll={() => engine.emitFrame()}
      onPointerDown={(e) => {
        /* クリップとルーラー以外＝空き地のクリックで選択を解除する。 */
        const el = e.target as Element;
        if (!el.closest(".clip") && !el.closest(".ruler")) engine.select(null);
      }}
    >
      <Ruler width={width} pxPerSec={snap.pxPerSec} />

      <div className="lanes" style={{ width }}>
        {snap.tracks.map((t) => (
          <div className="lane" key={t.id} data-testid="lane">
            <Clip t={t} pxPerSec={snap.pxPerSec} />
          </div>
        ))}
      </div>

      <Needle reel={reel} pxPerSec={snap.pxPerSec} visible={snap.tracks.length > 0} />

      {snap.tracks.length === 0 && (
        <div className="blank">
          <strong>音声ファイルをここへドロップ</strong>
          <span>
            mp3 / wav / m4a / ogg / flac — 1ファイル＝1トラック
            <br />
            ファイルはこの端末から出ません（サーバー送信なし）
          </span>
        </div>
      )}
    </div>
  );
}
