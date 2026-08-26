import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { engine } from "./audio/instance";
import { Deck } from "./components/Deck";
import { Probe } from "./components/Probe";
import { Reel } from "./components/Reel";
import { TrackHead } from "./components/TrackHead";

export default function App() {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [armed, setArmed] = useState(false);

  /* Space で再生／一時停止。フォーム上のキー入力は横取りしない。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target?.matches?.("input, button")) return;
      if (e.code !== "Space") return;
      e.preventDefault();
      engine.toggle();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  /* テーマ切り替え時のルーラーの描き直しは Ruler 自身が matchMedia を購読して行う。 */

  /* ドラッグ＆ドロップ。dragenter/leave は子要素をまたぐたびに飛ぶので深さで数える。 */
  const depth = useDropDepth(setArmed);

  return (
    <>
      <Deck snap={snap} />

      <div
        className={`stage${armed ? " armed" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (++depth.current === 1) setArmed(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          if (--depth.current <= 0) {
            depth.current = 0;
            setArmed(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setArmed(false);
          if (e.dataTransfer.files.length) void engine.ingest(e.dataTransfer.files);
        }}
      >
        <div className="rack">
          <div className="rack-top">Tracks</div>
          <div className="rack-list">
            {snap.tracks.map((t) => (
              <TrackHead t={t} key={t.id} />
            ))}
          </div>
        </div>

        <Reel snap={snap} />

        <div className="catch">ドロップして読み込む</div>
      </div>

      <Probe snap={snap} />
    </>
  );
}

function useDropDepth(setArmed: Dispatch<SetStateAction<boolean>>) {
  const depth = useRef(0);
  useEffect(() => {
    /* ウィンドウの外へ抜けた場合は dragleave が届かないことがあるので保険。 */
    const reset = () => {
      depth.current = 0;
      setArmed(false);
    };
    addEventListener("dragend", reset);
    addEventListener("drop", reset);
    return () => {
      removeEventListener("dragend", reset);
      removeEventListener("drop", reset);
    };
  }, [setArmed]);
  return depth;
}
