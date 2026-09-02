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
import { DrumPanel } from "./components/DrumPanel";
import { RollPanel } from "./components/RollPanel";
import { FxPanel } from "./components/FxPanel";
import { Probe } from "./components/Probe";
import { ContextMenu, type MenuAt } from "./components/ContextMenu";
import { Reel } from "./components/Reel";
import { TrackHead } from "./components/TrackHead";
import {
  clearProject,
  freeBytes,
  loadMetaSync,
  loadProject,
  requestPersist,
  saveProject,
} from "./lib/store";

export default function App() {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [armed, setArmed] = useState(false);
  /* 端末内に保存済みプロジェクトがあるか。中身は使わず有無と日時だけ見る。 */
  const [savedAt, setSavedAt] = useState<number | null>(() => loadMetaSync()?.savedAt ?? null);
  const [storeBusy, setStoreBusy] = useState(false);
  /* 右クリックメニュー（#78）。表示だけの状態なのでここに置く。 */
  const [menu, setMenu] = useState<MenuAt | null>(null);

  /* 起動時に保存データがあれば、ログ欄で復元を提案する（初回マウント時のみ）。 */
  useEffect(() => {
    const meta = loadMetaSync();
    if (meta && engine.getSnapshot().tracks.length === 0) {
      engine.notify(
        `前回保存したプロジェクト（${new Date(meta.savedAt).toLocaleString()}）があります。「前回を復元」で戻せます。`,
      );
    }
  }, []);

  const save = async () => {
    const p = engine.exportProject();
    if (!p || storeBusy) return;
    setStoreBusy(true);
    try {
      const size = p.blobs.reduce((n, b) => n + b.size, 0);
      const free = await freeBytes();
      if (free !== null && size > free) {
        engine.notify(
          `保存できません: 音声 ${(size / 1048576).toFixed(1)}MB がブラウザの空き容量（約 ${(free / 1048576).toFixed(0)}MB）を超えています。`,
        );
        return;
      }
      requestPersist();
      await saveProject(p.meta, p.blobs);
      setSavedAt(p.meta.savedAt);
      engine.notify(
        `プロジェクトを保存しました（トラック ${p.meta.tracks.length} 本 / 音声 ${(size / 1048576).toFixed(1)}MB / この端末のブラウザ内のみ）。`,
      );
    } catch (err) {
      engine.notify(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreBusy(false);
    }
  };

  const restore = async () => {
    if (storeBusy) return;
    setStoreBusy(true);
    try {
      const p = await loadProject();
      if (!p) {
        setSavedAt(null);
        engine.notify("保存データが見つかりませんでした。");
        return;
      }
      await engine.importProject(p.meta, p.blobs);
      engine.notify(
        `前回のプロジェクトを復元しました（トラック ${p.meta.tracks.length} 本 / 保存日時 ${new Date(p.meta.savedAt).toLocaleString()}）。`,
      );
    } catch (err) {
      engine.notify(`復元に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreBusy(false);
    }
  };

  const discard = async () => {
    if (storeBusy) return;
    setStoreBusy(true);
    try {
      await clearProject();
      setSavedAt(null);
      engine.notify("保存データを削除しました。");
    } catch (err) {
      engine.notify(`保存データの削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreBusy(false);
    }
  };

  /* Space で再生／一時停止、Delete / Backspace で選択中トラックの削除。
     フォーム上のキー入力は横取りしない。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target?.matches?.("input, button")) return;
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        engine.removeSelected();
        return;
      }
      /* Ctrl+D / Cmd+D で選択中トラックの複製（#77）。preventDefault で
         ブラウザのブックマーク登録を抑止する。 */
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") {
        e.preventDefault();
        engine.duplicateSelected();
        return;
      }
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
      <Deck
        snap={snap}
        savedAt={savedAt}
        storeBusy={storeBusy}
        onSave={() => void save()}
        onRestore={() => void restore()}
        onDiscard={() => void discard()}
      />

      <div
        className={`stage${armed ? " armed" : ""}`}
        onContextMenu={(e) => {
          /* クリップ / ヘッダ（data-track-id 持ち）の上でだけ自前メニューを出す。
             委譲にしてあるのは、Reel → Clip とプロップを掘らないため。 */
          const hit = (e.target as Element).closest?.("[data-track-id]");
          if (!hit) return;
          e.preventDefault();
          const id = hit.getAttribute("data-track-id");
          if (!id) return;
          engine.select(id);
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
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
              <TrackHead
                t={t}
                fxOpen={snap.fxId === t.id}
                drumsOpen={snap.drumsId === t.id}
                rollOpen={snap.rollId === t.id}
                key={t.id}
              />
            ))}
          </div>
        </div>

        <Reel snap={snap} />

        <div className="catch">ドロップして読み込む</div>
      </div>

      <FxPanel snap={snap} />
      <DrumPanel snap={snap} />
      <RollPanel snap={snap} />
      {menu && <ContextMenu at={menu} onClose={() => setMenu(null)} />}
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
