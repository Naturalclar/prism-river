import { decodeMeta, encodeMeta, PROJECT_VERSION, type ProjectMeta } from "./store";
import { buildZip, readZip, ZipError } from "./zip";

/**
 * プロジェクトを1ファイルに書き出す / 読み込む（#81）。
 *
 * 中身は無圧縮 ZIP: `project.json`（`ProjectMeta` そのまま）＋
 * `audio/<n>.<ext>`（各トラックの元ファイルのバイト列）。端末内の保存
 * （store.ts・localStorage + IndexedDB）と同じ直列化を、ブラウザの外へ
 * 持ち出せる形にしただけで、サーバーには何も送らない。
 */

export const PROJECT_FILE_EXT = ".prism";
export const PROJECT_FILE_NAME = "prism-river-project.prism";
const META_ENTRY = "project.json";

export function isProjectFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_FILE_EXT);
}

function extOf(srcName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(srcName);
  return m ? m[1].toLowerCase() : "bin";
}

/** 音声の項目名。srcName の拡張子を残すのは、復元側が拡張子で経路を選ぶため。 */
export function audioEntryName(index: number, srcName: string): string {
  return `audio/${index}.${extOf(srcName)}`;
}

export async function packProject(meta: ProjectMeta, blobs: Blob[]): Promise<Blob> {
  const entries = [{ name: META_ENTRY, data: new TextEncoder().encode(encodeMeta(meta)) }];
  for (let i = 0; i < blobs.length; i++) {
    entries.push({
      name: audioEntryName(i, meta.tracks[i]?.srcName ?? ""),
      // oxlint-disable-next-line no-await-in-loop
      data: new Uint8Array(await blobs[i].arrayBuffer()),
    });
  }
  return new Blob([buildZip(entries)], { type: "application/zip" });
}

export type UnpackResult = { meta: ProjectMeta; blobs: Blob[] } | { error: string };

/**
 * ファイルを開いて検証する。壊れている・版が新しい・音声が欠けている、を
 * それぞれ理由の分かる文言で返す。例外は投げない（#4 と同じ作法）。
 */
export function unpackProject(bytes: Uint8Array<ArrayBuffer>): UnpackResult {
  let entries;
  try {
    entries = readZip(bytes);
  } catch (err) {
    return {
      error: `プロジェクトファイルとして読めません: ${err instanceof ZipError ? err.message : String(err)}`,
    };
  }
  const metaEntry = entries.find((e) => e.name === META_ENTRY);
  if (!metaEntry) {
    return { error: `プロジェクトファイルとして読めません（${META_ENTRY} が入っていません）。` };
  }
  const json = new TextDecoder().decode(metaEntry.data);
  const meta = decodeMeta(json);
  if (!meta) {
    /* 版違いか、それ以外の破損かを分けて伝える。 */
    let version: unknown;
    try {
      version = (JSON.parse(json) as { version?: unknown }).version;
    } catch {
      version = undefined;
    }
    if (typeof version === "number" && version > PROJECT_VERSION) {
      return {
        error: `このファイルは新しい版（v${version}）で保存されています。このアプリが読めるのは v${PROJECT_VERSION} までです。`,
      };
    }
    return { error: "プロジェクトファイルの中身（project.json）が壊れています。" };
  }
  const blobs: Blob[] = [];
  for (let i = 0; i < meta.tracks.length; i++) {
    const name = audioEntryName(i, meta.tracks[i].srcName);
    const e = entries.find((x) => x.name === name);
    if (!e) return { error: `プロジェクトファイルに音声が欠けています（${name}）。` };
    blobs.push(new Blob([e.data]));
  }
  return { meta, blobs };
}
