/**
 * 最小限の ONNX ライター（#27）。依存ゼロで protobuf を直に書く。
 *
 * なぜ自前で書くか: #27 の計測には「実物と同じ形・同じ大きさのモデル」が要るが、
 * 学習済みの重みは**外から取らない**方針なので、こちらで作るしかない。
 * onnx / torch を dev 依存に足すとリポジトリの性格（JS だけで完結する）が変わるので、
 * 必要な範囲——ModelProto / GraphProto / NodeProto / TensorProto——だけを書く。
 *
 * 出るのは「乱数の重みを持つ、分離モデルと同じ形状の ONNX」。分離の精度は測れないが、
 * **モデルサイズと推論コストの関係**は実物と同じ土俵で測れる。
 */

/* ── protobuf の最小エンコーダ ───────────────────────────────────────── */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

const tag = (field, wire) => varint((field << 3) | wire);

/** field: varint（数値・列挙・bool）。 */
const pVarint = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);

/** field: length-delimited（文字列・bytes・入れ子メッセージ）。 */
function pBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

/** repeated varint を packed で書く（dims / ints 用）。 */
function pPacked(field, values) {
  const body = Buffer.concat(values.map((v) => varint(v)));
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

const cat = (...parts) => Buffer.concat(parts.flat());

/* ── ONNX のメッセージ ───────────────────────────────────────────────── */

const FLOAT = 1;

/** TensorProto（initializer）。重みは raw_data に little-endian の float32 で入れる。 */
export function tensor(name, dims, data) {
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return cat(
    pPacked(1, dims), // dims
    pVarint(2, FLOAT), // data_type
    pBytes(8, name), // name
    pBytes(9, raw), // raw_data
  );
}

/** AttributeProto。INT=2 / INTS=7 だけ使う。 */
const attrInts = (name, ints) => cat(pBytes(1, name), pVarint(20, 7), pPacked(8, ints));

/** NodeProto。 */
export function node(opType, inputs, outputs, attrs = []) {
  return cat(
    inputs.map((i) => pBytes(1, i)),
    outputs.map((o) => pBytes(2, o)),
    pBytes(3, `${opType}_${outputs[0]}`), // name
    pBytes(4, opType),
    attrs.map((a) => pBytes(5, a)), // attribute
  );
}

/** Conv / ConvTranspose の属性。3x3・pad 1 固定で、stride だけ変える。 */
export function convAttrs(stride, outputPadding = null) {
  const a = [
    attrInts("kernel_shape", [3, 3]),
    attrInts("pads", [1, 1, 1, 1]),
    attrInts("strides", [stride, stride]),
  ];
  if (outputPadding) a.push(attrInts("output_padding", outputPadding));
  return a;
}

/**
 * ValueInfoProto。shape の各次元は数値、または `"T"` のような記号（可変長）。
 * 時間軸を可変にしておかないと、尺ごとにモデルを作り直すことになる。
 */
export function valueInfo(name, dims) {
  const dimMsgs = dims.map((d) =>
    typeof d === "string" ? pBytes(2, d) : pVarint(1, d),
  );
  const shape = cat(dimMsgs.map((d) => pBytes(1, d))); // TensorShapeProto.dim
  const tensorType = cat(pVarint(1, FLOAT), pBytes(2, shape));
  const type = pBytes(1, tensorType); // TypeProto.tensor_type
  return cat(pBytes(1, name), pBytes(2, type));
}

/** GraphProto → ModelProto。ir_version 8 / opset 13。 */
export function model({ nodes, initializers, inputs, outputs, name = "prism-river-probe" }) {
  const graph = cat(
    nodes.map((n) => pBytes(1, n)),
    pBytes(2, name),
    initializers.map((t) => pBytes(5, t)),
    inputs.map((v) => pBytes(11, v)),
    outputs.map((v) => pBytes(12, v)),
  );
  const opset = cat(pBytes(1, ""), pVarint(2, 13));
  return cat(
    pVarint(1, 8), // ir_version
    pBytes(2, "prism-river"), // producer_name
    pBytes(7, graph),
    pBytes(8, opset),
  );
}

/* ── 分離モデルと同じ形の合成モデル ─────────────────────────────────── */

/**
 * 乱数の重み。値の分布は速度に効かない（浮動小数の演算数は同じ）ので、
 * 決定的な擬似乱数で十分——同じサイズのモデルが毎回同じバイト数になる。
 *
 * 正の側に寄せてあるのは、ReLU を何段も通しても活性が死なないようにするため。
 * 全部 0 に潰れたモデルでも conv の演算数は変わらないので速度は測れるが、
 * 「動いているものを測っている」ことが結果から見えなくなる。
 */
function weights(count, seed, fanIn) {
  /* He 初期化（±sqrt(6/fanIn) の一様分布）。段を重ねても活性が 0 にも
     飽和にも倒れない——スケールを外すと出力が全部同じ値になり、
     「動いているものを測っている」ことが結果から見えなくなる。 */
  const limit = Math.sqrt(6 / fanIn);
  const a = new Float32Array(count);
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s / 0x1_0000_0000 - 0.5) * 2 * limit;
  }
  return a;
}

/**
 * スペクトログラムのマスクを推定する U-Net 型のモデルを組む（#27）。
 *
 * 実物（MDX-Net / Demucs 系）と同じ「stride 2 で畳んで、同じ深さだけ戻す」形。
 * `width` を上げるとパラメータ数＝ファイルサイズが増え、計算量も一緒に増える——
 * 実物と同じ比例関係になるので、サイズを振れば推論コストの傾きが測れる。
 *
 * 入力は [1, 2, FREQ, T]（L/R の振幅スペクトログラム）、出力も同じ形のマスク。
 */
export function buildSeparator({ width = 32, depth = 5, freq = 512 }) {
  const nodes = [];
  const inits = [];
  let seed = 1;
  let cin = 2;
  const chan = [];

  /* エンコーダ: stride 2 で周波数・時間を半分にしながらチャンネルを倍にする。 */
  for (let d = 0; d < depth; d++) {
    const cout = width * 2 ** d;
    chan.push(cout);
    const w = weights(cout * cin * 9, seed++, cin * 9);
    inits.push(tensor(`enc${d}.w`, [cout, cin, 3, 3], w));
    nodes.push(node(`Conv`, [d === 0 ? "mix" : `e${d - 1}`, `enc${d}.w`], [`c${d}`], convAttrs(2)));
    nodes.push(node("Relu", [`c${d}`], [`e${d}`]));
    cin = cout;
  }

  /* デコーダ: ConvTranspose で戻す。出力を入力と同じ大きさに揃えるため
     output_padding を 1 にする（stride 2・pad 1・kernel 3 の組み合わせ）。 */
  for (let d = depth - 1; d >= 0; d--) {
    const cout = d === 0 ? 2 : chan[d - 1];
    const w = weights(cin * cout * 9, seed++, cin * 9);
    inits.push(tensor(`dec${d}.w`, [cin, cout, 3, 3], w));
    const src = d === depth - 1 ? `e${depth - 1}` : `d${d + 1}`;
    nodes.push(
      node("ConvTranspose", [src, `dec${d}.w`], [`u${d}`], convAttrs(2, [1, 1])),
    );
    nodes.push(node(d === 0 ? "Sigmoid" : "Relu", [`u${d}`], [d === 0 ? "mask" : `d${d}`]));
    cin = cout;
  }

  const bytes = model({
    nodes,
    initializers: inits,
    inputs: [valueInfo("mix", [1, 2, freq, "T"])],
    outputs: [valueInfo("mask", [1, 2, freq, "T"])],
  });

  return { bytes, freq, depth, width };
}
