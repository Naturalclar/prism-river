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
  autoSaveOn,
  clearProject,
  freeBytes,
  loadMetaSync,
  loadProject,
  requestPersist,
  sameBlobs,
  saveMeta,
  saveProject,
  setAutoSaveOn,
} from "./lib/store";

/**
 * 自動保存の待ち時間（ms）。スライダーを動かしている最中は `touched()` が
 * 毎フレーム飛ぶので、止まってからまとめて1回書く。
 */
const AUTOSAVE_DELAY = 1200;

export default function App() {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [armed, setArmed] = useState(false);
  /* 端末内に保存済みプロジェクトがあるか。中身は使わず有無と日時だけ見る。 */
  const [savedAt, setSavedAt] = useState<number | null>(() => loadMetaSync()?.savedAt ?? null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [auto, setAuto] = useState(autoSaveOn);
  /* 前回書いた音声。同じ顔ぶれなら音声は書き直さない（メタだけで済む）。 */
  const savedBlobs = useRef<Blob[] | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 自動保存の失敗を伝えるのは一度だけ。毎回出すとログが埋まる。 */
  const autoFailed = useRef(false);
  /* 右クリックメニュー（#78）。表示だけの状態なのでここに置く。 */
  const [menu, setMenu] = useState<MenuAt | null>(null);

  /* 起動時に保存データがあれば、そのまま復元して前回の続きから始める（#80）。
     「提案して待つ」をやめたのは、押しそびれたときに戻す手立てが無かったため
     （「前回を復元」はトラックが0本のときしか出ない）。 */
  useEffect(() => {
    if (!loadMetaSync() || engine.getSnapshot().tracks.length) return;
    void restoreInto("前回の続きから開きました", true);
    /* 初回マウントのみ。restoreInto は state setter と ref しか触らない。 */
    // oxlint-disable-next-line exhaustive-deps
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
      savedBlobs.current = p.blobs;
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

  /**
   * 保存データを読み戻す。起動時の自動復元（#80）と「前回を復元」の両方が通る。
   * `openedByItself` は起動時に自分から戻したときで、そうと分かる文言にする。
   */
  const restoreInto = async (lead: string, openedByItself: boolean) => {
    if (storeBusy) return;
    setStoreBusy(true);
    engine.notify(openedByItself ? "前回のプロジェクトを読み込んでいます …" : "復元中 …");
    try {
      const p = await loadProject();
      if (!p) {
        setSavedAt(null);
        engine.notify("保存データが見つかりませんでした。");
        return;
      }
      await engine.importProject(p.meta, p.blobs);
      /* 復元した Blob がそのままトラックの srcBytes になるので、これを
         「書いてある音声」として控える。直後の自動保存が音声を書き直さない。 */
      savedBlobs.current = p.blobs;
      cancelAutoSave();
      engine.notify(
        `${lead}（トラック ${p.meta.tracks.length} 本 / 保存日時 ${new Date(p.meta.savedAt).toLocaleString()}）。` +
          (openedByItself ? "まっさらから始めるなら「保存データを消す」。" : ""),
      );
    } catch (err) {
      /* 壊れた保存データで起動できなくなるのが最悪なので、空のまま立ち上げて
         理由だけ伝える。 */
      engine.notify(`復元に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreBusy(false);
    }
  };

  const discard = async () => {
    if (storeBusy) return;
    setStoreBusy(true);
    try {
      cancelAutoSave();
      await clearProject();
      savedBlobs.current = null;
      setSavedAt(null);
      engine.notify("保存データを削除しました。");
    } catch (err) {
      engine.notify(`保存データの削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreBusy(false);
    }
  };

  function cancelAutoSave() {
    if (autoTimer.current !== null) clearTimeout(autoTimer.current);
    autoTimer.current = null;
  }

  /* 自動保存（#80）。音に効く変更（touched）だけを受けて、止まってから1回書く。 */
  useEffect(() => {
    if (!auto) return;

    const write = async () => {
      const p = engine.exportProject();
      /* トラックが0本のときは書かない。全部消したことを保存に反映すると、
         誤って消した作業が保存データごと消える。「前回を復元」で戻せる状態を
         残しておく方がよい（意図して消すなら「保存データを消す」がある）。 */
      if (!p) return;
      try {
        if (sameBlobs(p.blobs, savedBlobs.current)) {
          /* 音声は変わっていない＝メタ（数KB）だけ。 */
          saveMeta(p.meta);
        } else {
          requestPersist();
          await saveProject(p.meta, p.blobs);
          savedBlobs.current = p.blobs;
        }
        setSavedAt(p.meta.savedAt);
        autoFailed.current = false;
      } catch (err) {
        /* 容量不足などで書けないことは黙って起きる。ここで伝えないと、
           「保存されているつもり」のまま作業を続けることになる。 */
        if (autoFailed.current) return;
        autoFailed.current = true;
        engine.notify(
          `自動保存できませんでした: ${err instanceof Error ? err.message : String(err)}。` +
            "「プロジェクトを保存」で手動保存を試すか、不要なトラックを減らしてください。",
        );
      }
    };

    return engine.onTouched(() => {
      if (autoTimer.current !== null) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => void write(), AUTOSAVE_DELAY);
    });
  }, [auto]);

  /* 自動保存の ON / OFF。切ったら書きかけの予約も取り消す。 */
  const toggleAuto = () => {
    const next = !auto;
    if (!next) cancelAutoSave();
    setAutoSaveOn(next);
    setAuto(next);
    engine.notify(
      next
        ? "自動保存を ON にしました。編集するたび、この端末のブラウザ内に保存します。"
        : "自動保存を OFF にしました。以後は「プロジェクトを保存」を押したときだけ保存します。",
    );
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
        auto={auto}
        onSave={() => void save()}
        onRestore={() => void restoreInto("前回のプロジェクトを復元しました", false)}
        onDiscard={() => void discard()}
        onToggleAuto={toggleAuto}
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
