import { useEffect, useRef } from "react";
import { engine } from "../audio/instance";

export type MenuAt = { x: number; y: number; id: string };

/**
 * クリップ / トラックヘッダの右クリックメニュー（#78）。段1は 複製 / 削除。
 * 表示だけの状態なので React のローカル state（App）に置き、Engine には
 * 持たせない——オーディオの状態を React に持たせないの逆で、UI だけの状態を
 * オーディオ側に持たせない。
 */
export function ContextMenu({ at, onClose }: { at: MenuAt; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);

  /* 外側クリックと Escape で閉じる。capture で聴くので、閉じた上でクリック先の
     操作（選択など）はそのまま通る。 */
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key, true);
    return () => {
      removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  /* 画面端では内側へ寄せる。メニューは小さいので固定幅ぶんのクランプでよい。 */
  const left = Math.max(0, Math.min(at.x, window.innerWidth - 140));
  const top = Math.max(0, Math.min(at.y, window.innerHeight - 90));

  return (
    <div
      ref={box}
      className="ctxmenu"
      style={{ left, top }}
      role="menu"
      data-testid="ctxmenu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        role="menuitem"
        onClick={() => {
          engine.duplicate(at.id);
          onClose();
        }}
      >
        複製
      </button>
      <button
        role="menuitem"
        className="danger"
        onClick={() => {
          engine.remove(at.id);
          onClose();
        }}
      >
        削除
      </button>
    </div>
  );
}
