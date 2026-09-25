import { describe, expect, it } from "vitest";
import { buildSeparator, model, node, tensor, valueInfo } from "./onnx.mjs";

/**
 * 自前 ONNX ライター（#27）の検証。
 *
 * ここを間違えると「読めない ONNX が黙って出来る」だけで、気づくのは計測を
 * 回してブラウザが例外を投げたとき——原因の切り分けに時間がかかる型なので、
 * protobuf の下地だけでも押さえておく。
 *
 * 期待値は protobuf の仕様そのもの（可変長整数の並びとタグの作り方）で、
 * このコードから導いたものではない。
 */

/** バイト列の先頭が期待どおりか。 */
const head = (buf, n) => [...buf.subarray(0, n)];

describe("protobuf の下地", () => {
  it("フィールド1・length-delimited のタグは 0x0A", () => {
    /* ValueInfoProto.name（フィールド1・文字列）→ タグ 0x0A + 長さ + 中身。 */
    const v = valueInfo("mix", [1]);
    expect(head(v, 5)).toEqual([0x0a, 0x03, 0x6d, 0x69, 0x78]); // "mix"
  });

  it("128 以上の長さは可変長整数で 2 バイトになる", () => {
    /* raw_data が 300 バイト（float32 × 75）の TensorProto。300 = 0xAC 0x02。 */
    const t = tensor("w", [75], new Float32Array(75));
    expect([...t].includes(0xac)).toBe(true);
    /* dims / data_type / name / raw_data の4フィールドぶんより長い。 */
    expect(t.length).toBeGreaterThan(300);
  });

  it("ModelProto は ir_version 8 から始まる", () => {
    const m = model({
      nodes: [node("Relu", ["a"], ["b"])],
      initializers: [],
      inputs: [valueInfo("a", [1])],
      outputs: [valueInfo("b", [1])],
    });
    /* フィールド1・varint（タグ 0x08）に 8。 */
    expect(head(m, 2)).toEqual([0x08, 0x08]);
  });

  it("op_type と入出力の名前がそのまま入る", () => {
    const n = node("Conv", ["x", "w"], ["y"]);
    expect(n.includes(Buffer.from("Conv"))).toBe(true);
    expect(n.includes(Buffer.from("x"))).toBe(true);
    expect(n.includes(Buffer.from("y"))).toBe(true);
  });
});

describe("合成モデル", () => {
  it("width を上げるとサイズが増える（計測はこの比例関係を使う）", () => {
    const small = buildSeparator({ width: 8, depth: 3, freq: 64 }).bytes.length;
    const big = buildSeparator({ width: 16, depth: 3, freq: 64 }).bytes.length;
    /* チャンネル数が倍なら畳み込みの重みは概ね4倍。 */
    expect(big).toBeGreaterThan(small * 3);
  });

  it("同じ引数なら毎回同じバイト列（重みが決定的な擬似乱数）", () => {
    const a = buildSeparator({ width: 8, depth: 3, freq: 64 }).bytes;
    const b = buildSeparator({ width: 8, depth: 3, freq: 64 }).bytes;
    expect(a.equals(b)).toBe(true);
  });

  it("Conv と ConvTranspose が同じ段数だけ入る", () => {
    const { bytes } = buildSeparator({ width: 8, depth: 4, freq: 64 });
    const s = bytes.toString("latin1");
    /* ConvTranspose にも "Conv" が含まれるので、差を取って数える。 */
    const transposes = s.split("ConvTranspose").length - 1;
    const convs = s.split("Conv").length - 1 - transposes;
    /* op_type と node name の2か所に名前が入るので、段数の2倍ずつ出る。 */
    expect(transposes).toBe(4 * 2);
    expect(convs).toBe(4 * 2);
  });
});
