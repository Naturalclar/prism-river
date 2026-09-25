/**
 * 無圧縮（stored）ZIP の読み書き（#81）。DOM に依存しない純粋関数。
 *
 * プロジェクトファイル用。音声は既に mp3 / webm 等で圧縮済みなので ZIP の
 * 圧縮は効かず、stored だけなら CRC32 とヘッダを書くだけで済む（依存ゼロ）。
 * 他のツールでも開ける普通の ZIP になるのが、この形式を選ぶ理由の一つ。
 *
 * 対応外: 圧縮された ZIP（deflate 等）、zip64（4GB 超）、暗号化。読むときに
 * 出会ったら理由の分かる ZipError を投げる。
 */

export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> };

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/* 汎用フラグ bit 11: ファイル名は UTF-8。 */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS の日時（ZIP ヘッダの形式）。秒は2秒単位。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const names = entries.map((e) => enc.encode(e.name));
  const crcs = entries.map((e) => crc32(e.data));

  let localSize = 0;
  for (let i = 0; i < entries.length; i++) localSize += 30 + names[i].length + entries[i].data.length;
  let centralSize = 0;
  for (const n of names) centralSize += 46 + n.length;
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    offsets.push(at);
    v.setUint32(at, SIG_LOCAL, true);
    v.setUint16(at + 4, 20, true); /* version needed: 2.0 */
    v.setUint16(at + 6, FLAG_UTF8, true);
    v.setUint16(at + 8, 0, true); /* method: stored */
    v.setUint16(at + 10, time, true);
    v.setUint16(at + 12, date, true);
    v.setUint32(at + 14, crcs[i], true);
    v.setUint32(at + 18, entries[i].data.length, true);
    v.setUint32(at + 22, entries[i].data.length, true);
    v.setUint16(at + 26, names[i].length, true);
    v.setUint16(at + 28, 0, true); /* extra length */
    out.set(names[i], at + 30);
    out.set(entries[i].data, at + 30 + names[i].length);
    at += 30 + names[i].length + entries[i].data.length;
  }

  const centralAt = at;
  for (let i = 0; i < entries.length; i++) {
    v.setUint32(at, SIG_CENTRAL, true);
    v.setUint16(at + 4, 20, true); /* version made by */
    v.setUint16(at + 6, 20, true); /* version needed */
    v.setUint16(at + 8, FLAG_UTF8, true);
    v.setUint16(at + 10, 0, true);
    v.setUint16(at + 12, time, true);
    v.setUint16(at + 14, date, true);
    v.setUint32(at + 16, crcs[i], true);
    v.setUint32(at + 20, entries[i].data.length, true);
    v.setUint32(at + 24, entries[i].data.length, true);
    v.setUint16(at + 28, names[i].length, true);
    v.setUint16(at + 30, 0, true); /* extra */
    v.setUint16(at + 32, 0, true); /* comment */
    v.setUint16(at + 34, 0, true); /* disk */
    v.setUint16(at + 36, 0, true); /* internal attrs */
    v.setUint32(at + 38, 0, true); /* external attrs */
    v.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  }

  v.setUint32(at, SIG_EOCD, true);
  v.setUint16(at + 4, 0, true);
  v.setUint16(at + 6, 0, true);
  v.setUint16(at + 8, entries.length, true);
  v.setUint16(at + 10, entries.length, true);
  v.setUint32(at + 12, centralSize, true);
  v.setUint32(at + 16, centralAt, true);
  v.setUint16(at + 20, 0, true);
  return out;
}

/**
 * ZIP をエントリ列に開く。中央ディレクトリから辿るので、ローカルヘッダの
 * 値（後書きで 0 のことがある）には頼らない。CRC も検算する。
 */
export function readZip(bytes: Uint8Array<ArrayBuffer>): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /* EOCD は末尾から探す（コメント付きの ZIP は末尾が EOCD でない）。 */
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("ZIP として読めません（末尾のディレクトリがありません）。");
  const count = v.getUint16(eocd + 10, true);
  const centralAt = v.getUint32(eocd + 16, true);
  if (centralAt >= bytes.length) throw new ZipError("ZIP が壊れています（ディレクトリの位置が範囲外）。");

  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipError("ZIP が壊れています（ディレクトリの項目が読めません）。");
    }
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (method !== 0) {
      throw new ZipError(
        `圧縮された ZIP は読めません（${name} が method ${method}）。このアプリが書き出した無圧縮の ZIP だけ対応しています。`,
      );
    }
    if (offset + 30 > bytes.length || v.getUint32(offset, true) !== SIG_LOCAL) {
      throw new ZipError(`ZIP が壊れています（${name} のヘッダが読めません）。`);
    }
    const lNameLen = v.getUint16(offset + 26, true);
    const lExtraLen = v.getUint16(offset + 28, true);
    const start = offset + 30 + lNameLen + lExtraLen;
    if (start + size > bytes.length) throw new ZipError(`ZIP が途中で切れています（${name}）。`);
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new ZipError(`ZIP の中身が壊れています（${name} の CRC 不一致）。`);
    entries.push({ name, data });
  }
  return entries;
}
