import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { makeGarbage, makeTone } from "./fixture";

/**
 * テスト音源の置き方そのものの検証（#90）。
 *
 * 以前は共有ディレクトリに名前そのままで書いていたので、同じ名前で違う中身を
 * 要求する2つのテストが同じパスを奪い合い、書きかけのファイルを読んだ側が
 * 落ちていた。ここで見るのは「違う中身は同じパスに来ない」の1点。
 */

describe("テスト音源の置き場", () => {
  it("同じ中身なら同じパスを返す（無駄に書き直さない）", () => {
    expect(makeTone("same.wav", 440, 1)).toBe(makeTone("same.wav", 440, 1));
  });

  it("名前が同じでも中身が違えば別のパスになる", () => {
    /* まさに #84 で起きた組み合わせ: 同じ名前・違う長さ。 */
    const short = makeTone("dup.wav", 440, 1);
    const long = makeTone("dup.wav", 440, 2);
    expect(short).not.toBe(long);
    /* 周波数だけ違う場合も同じ。 */
    expect(makeTone("dup.wav", 440, 1)).not.toBe(makeTone("dup.wav", 330, 1));
  });

  it("ファイル名（basename）は渡したまま", () => {
    /* トラック名は取り込んだファイル名から作るので、ここを変えると
       各 spec の表示検証が全部ずれる。 */
    expect(basename(makeTone("keepname.wav", 440, 1))).toBe("keepname.wav");
    expect(basename(makeGarbage("broken.flac"))).toBe("broken.flac");
  });

  it("違う中身は別ディレクトリに分かれ、中身は要求どおり", () => {
    const a = makeTone("split.wav", 440, 1);
    const b = makeTone("split.wav", 440, 2);
    expect(dirname(a)).not.toBe(dirname(b));
    /* 2秒の方がバイト数が多い（＝取り違えていない）。 */
    expect(readFileSync(b).byteLength).toBeGreaterThan(readFileSync(a).byteLength);
  });
});
