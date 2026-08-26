/**
 * プロジェクトの保存・復元（#18）。
 *
 * 置き場所は2段に分ける:
 * - メタ（トラックの設定・JSON にできる軽いもの）→ localStorage
 * - 音声（読み込んだ元ファイルのバイト列そのまま）→ IndexedDB
 *
 * デコード済み PCM ではなく元ファイルを保存するのは、mp3 等なら 1/10 程度の
 * サイズで済み、復元が既存のデコード経路をそのまま通る（＝デコード時間の
 * テレメトリも自然に再計測される）ため。
 *
 * Engine はここに依存しない。Engine が出す/受けるのはシリアライズ可能な
 * `ProjectMeta` + `Blob[]` だけで、ストレージの都合はこのモジュールに閉じる。
 */

/** 保存形式のバージョン。フィールドの追加時に上げる（v2: fx を追加）。 */
export const PROJECT_VERSION = 2;

/** トラックエフェクト。engine.ts の TrackFx と構造互換（循環 import を避けて別定義）。 */
export type FxMeta = {
  eq: { low: number; mid: number; high: number };
  comp: { on: boolean; threshold: number; ratio: number; attack: number; release: number };
};

/** v1 の保存データ（fx 無し）を読むときの補完値。engine の既定と同じ。 */
export const defaultFxMeta = (): FxMeta => ({
  eq: { low: 0, mid: 0, high: 0 },
  comp: { on: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 },
});

export type TrackMeta = {
  name: string;
  /** 元ファイル名（拡張子つき）。復元時の表示と再保存に使う。 */
  srcName: string;
  vol: number;
  panv: number;
  mute: boolean;
  solo: boolean;
  offset: number;
  trimStart: number;
  trimEnd: number;
  fadeIn: number;
  fadeOut: number;
  fx: FxMeta;
  color: string;
};

export type ProjectMeta = {
  version: number;
  savedAt: number;
  masterVol: number;
  pxPerSec: number;
  tracks: TrackMeta[];
};

/* ── メタの符号化（純粋関数・単体テスト対象） ─────────────────────────── */

export function encodeMeta(meta: ProjectMeta): string {
  return JSON.stringify(meta);
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";

function isFxMeta(v: unknown): v is FxMeta {
  if (typeof v !== "object" || v === null) return false;
  const f = v as { eq?: Record<string, unknown>; comp?: Record<string, unknown> };
  if (typeof f.eq !== "object" || f.eq === null) return false;
  if (typeof f.comp !== "object" || f.comp === null) return false;
  return (
    num(f.eq.low) &&
    num(f.eq.mid) &&
    num(f.eq.high) &&
    bool(f.comp.on) &&
    num(f.comp.threshold) &&
    num(f.comp.ratio) &&
    num(f.comp.attack) &&
    num(f.comp.release)
  );
}

/** fx を除く共通フィールド（v1 / v2 で同じ部分）。 */
function isTrackMetaBase(v: unknown): v is Omit<TrackMeta, "fx"> & { fx?: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    str(t.name) &&
    str(t.srcName) &&
    str(t.color) &&
    bool(t.mute) &&
    bool(t.solo) &&
    num(t.vol) &&
    num(t.panv) &&
    num(t.offset) &&
    num(t.trimStart) &&
    num(t.trimEnd) &&
    num(t.fadeIn) &&
    num(t.fadeOut)
  );
}

/**
 * 保存されていた JSON を検証して返す。壊れている・版が合わない場合は null。
 * v1（fx 無し）は fx を既定値で補って読む（既存の保存データを壊さない）。
 * 例外は投げない（起動時に毎回通る道なので、失敗は「保存なし」に倒す）。
 */
export function decodeMeta(json: string | null): ProjectMeta | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.version !== 1 && m.version !== PROJECT_VERSION) return null;
  if (!num(m.savedAt) || !num(m.masterVol) || !num(m.pxPerSec)) return null;
  if (!Array.isArray(m.tracks) || !m.tracks.every(isTrackMetaBase)) return null;
  if (m.version === PROJECT_VERSION && !m.tracks.every((t) => isFxMeta(t.fx))) return null;
  return {
    version: PROJECT_VERSION,
    savedAt: m.savedAt,
    masterVol: m.masterVol,
    pxPerSec: m.pxPerSec,
    /* JSON.parse 直後の自前オブジェクトなので、fx の補完はその場に書いてよい。 */
    tracks: m.tracks.map((t) => Object.assign(t, { fx: isFxMeta(t.fx) ? t.fx : defaultFxMeta() })),
  };
}

/* ── ストレージ本体 ───────────────────────────────────────────────────── */

const META_KEY = "prism-river.project";
const DB_NAME = "prism-river";
const DB_STORE = "audio";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.addEventListener("upgradeneeded", () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    });
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () =>
      reject(req.error ?? new Error("IndexedDB を開けませんでした")),
    );
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("IndexedDB への書き込みに失敗しました")),
    );
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB への書き込みが中断されました")),
    );
  });
}

/** 起動時の同期チェック用。保存があればメタを返す。 */
export function loadMetaSync(): ProjectMeta | null {
  try {
    return decodeMeta(localStorage.getItem(META_KEY));
  } catch {
    /* localStorage 自体が使えない環境（ストレージ無効化等）は「保存なし」扱い。 */
    return null;
  }
}

/**
 * プロジェクトを保存する。音声 → メタの順に書き、途中で失敗したら
 * メタは古いまま残る（半端な新メタで復元が壊れるよりよい）。
 */
export async function saveProject(meta: ProjectMeta, blobs: Blob[]): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    store.clear();
    blobs.forEach((b, i) => store.put(b, i));
    await done(tx);
  } finally {
    db.close();
  }
  localStorage.setItem(META_KEY, encodeMeta(meta));
}

/** 保存されたプロジェクトを読む。音声が欠けていたら例外（呼び出し側で伝える）。 */
export async function loadProject(): Promise<{ meta: ProjectMeta; blobs: Blob[] } | null> {
  const meta = loadMetaSync();
  if (!meta) return null;
  const db = await openDb();
  try {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const blobs = await Promise.all(
      meta.tracks.map(
        (_, i) =>
          new Promise<Blob>((resolve, reject) => {
            const req = store.get(i);
            req.addEventListener("success", () => {
              if (req.result instanceof Blob) resolve(req.result);
              else reject(new Error("保存された音声データが見つかりません"));
            });
            req.addEventListener("error", () =>
              reject(req.error ?? new Error("音声データを読めませんでした")),
            );
          }),
      ),
    );
    return { meta, blobs };
  } finally {
    db.close();
  }
}

/** 保存データを消す。メタ → 音声の順（メタが先に消えれば復元候補から外れる）。 */
export async function clearProject(): Promise<void> {
  localStorage.removeItem(META_KEY);
  const db = await openDb();
  try {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    await done(tx);
  } finally {
    db.close();
  }
}

/** ストレージの空き（bytes）。見積もりが取れない環境では null。 */
export async function freeBytes(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || !num(est.quota) || !num(est.usage)) return null;
    return Math.max(0, est.quota - est.usage);
  } catch {
    return null;
  }
}

/**
 * ブラウザ都合の自動削除を減らすための永続化要求。拒否されても保存自体は
 * 成立する（evictable なだけ）ので、結果は気にしない。
 */
export function requestPersist(): void {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* storage API が無いだけ */
  }
}
