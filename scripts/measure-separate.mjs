/**
 * 音源分離（ボーカル / 伴奏）を ONNX Runtime Web で回したときのコスト計測（#27）。
 *
 *   pnpm measure:separate
 *
 * **学習済みモデルは使わない。** #27 の方針で外部からモデルを取らないので、
 * 実物（MDX-Net / Demucs 系）と同じ形の U-Net を乱数の重みで組んで測る
 * （`scripts/separate/onnx.mjs`）。測れるのは**分離の精度ではなく、
 * モデルサイズと尺に対する推論コスト・メモリ**。#27 の段1と段3にあたる。
 *
 * アプリ本体には ONNX Runtime を入れていない（14MB の WASM を、使えるモデルが
 * 無いまま配る意味が無い）。ここは onnxruntime-web を devDependency として
 * 直接読み、素の HTML の上で走らせる。
 *
 * ブラウザは Playwright のもの。別の Chromium を使うなら CHROMIUM_PATH で指す。
 */

/* 計測なので直列実行が要件。並列にすると時間もメモリのピークも混ざる。 */
// oxlint-disable no-await-in-loop
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { buildSeparator } from "./separate/onnx.mjs";

const DIR = join(process.cwd(), "test-results", "separate");
const ORT = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");

/** 44.1kHz / hop 1024 のスペクトログラム。1秒あたり約43フレーム。 */
const SR = 44100;
const HOP = 1024;
const FREQ = 512;
const DEPTH = 5;
/** 時間軸は 2^DEPTH の倍数に丸める（stride 2 を DEPTH 段通すため）。 */
const GRID = 2 ** DEPTH;

/** モデルの大きさを振る。width がパラメータ数＝ファイルサイズを決める。 */
const WIDTHS = (process.env.MEASURE_WIDTHS ?? "16,32,64,96").split(",").map(Number);
/** 尺を振る（秒）。実用尺（3〜5分）まで伸ばして、どこで止まるかを見る。 */
const SECONDS = (process.env.MEASURE_SECONDS ?? "10,30,60,180,300").split(",").map(Number);

/** COOP/COEP を付けるか（＝SharedArrayBuffer を使わせるか）。 */
const COI = process.env.MEASURE_COI !== "0";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".map": "application/json",
};

/** dist と生成物を並べて配る、依存ゼロの静的サーバー。 */
function serve(dirs) {
  const server = createServer((req, res) => {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path.endsWith("/")) path += "index.html";
    for (const dir of dirs) {
      const file = join(dir, path);
      if (!file.startsWith(dir)) continue;
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        /* COOP/COEP を付けると SharedArrayBuffer が使えて ORT がスレッドを張る。
           GitHub Pages 単体ではこのヘッダを付けられないので、MEASURE_COI=0 で
           外した状態（＝素の Pages 相当）も測れるようにしてある。 */
        ...(COI
          ? {
              "cross-origin-opener-policy": "same-origin",
              "cross-origin-embedder-policy": "require-corp",
            }
          : {}),
      });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** ブラウザのプロセスツリー全体の RSS（MB）。WASM のヒープは JS ヒープの外に乗る。 */
function treeRssMb(pid) {
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,rss"], { encoding: "utf8" });
    const rows = out
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp] of rows) {
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push(p);
    }
    let total = 0;
    const walk = (p) => {
      const self = rows.find((r) => r[0] === p);
      if (self) total += self[2];
      for (const k of kids.get(p) ?? []) walk(k);
    };
    walk(pid);
    return total / 1024;
  } catch {
    return null;
  }
}

function findBrowserPid() {
  try {
    const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (/(chrome|chromium|headless_shell)/.test(line) && !/--type=/.test(line)) {
        return Number(line.trim().split(/\s+/)[0]);
      }
    }
  } catch {
    /* ps が無い環境では RSS を測らない */
  }
  return null;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>separate probe</title>
<script src="/ort.min.js"></script>
<script>
  window.ort.env.wasm.wasmPaths = "/";
  window.probe = async (model, frames) => {
    const t0 = performance.now();
    const session = await window.ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    const loadMs = performance.now() - t0;

    const n = 1 * 2 * ${FREQ} * frames;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin(i * 0.001) * 0.5 + 0.5;
    const tensor = new window.ort.Tensor("float32", input, [1, 2, ${FREQ}, frames]);

    const t1 = performance.now();
    const out = await session.run({ mix: tensor });
    const runMs = performance.now() - t1;

    const mask = out.mask.data;
    let sum = 0;
    for (let i = 0; i < mask.length; i += 4096) sum += mask[i];
    await session.release();
    return { loadMs, runMs, outLength: mask.length, checksum: sum, threads: window.ort.env.wasm.numThreads };
  };
</script>`;

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "index.html"), PAGE);

/* モデルを作る。width ごとに1つで、尺（frames）は入力の形だけ変える。 */
const models = [];
for (const width of WIDTHS) {
  const { bytes } = buildSeparator({ width, depth: DEPTH, freq: FREQ });
  const name = `probe-w${width}.onnx`;
  writeFileSync(join(DIR, name), bytes);
  models.push({ width, name, mb: bytes.length / 1024 / 1024 });
  console.log(`model width=${width}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
}

const { server, port } = await serve([DIR, ORT]);
const base = `http://127.0.0.1:${port}/`;
console.log(`\nserving ${base}（COOP/COEP: ${COI ? "あり" : "なし"}）`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const pid = findBrowserPid();
const idleRss = pid ? treeRssMb(pid) : null;
console.log(`browser idle RSS: ${idleRss?.toFixed(0)} MB\n`);

const rows = [];
for (const m of models) {
  for (const seconds of SECONDS) {
    const frames = Math.max(GRID, Math.round((seconds * SR) / HOP / GRID) * GRID);
    const page = await browser.newPage();
    let failure = null;
    page.on("pageerror", (e) => (failure ??= `pageerror: ${e.message}`));
    page.on("crash", () => (failure ??= "renderer crash"));
    await page.goto(base);

    let r = null;
    const t0 = Date.now();
    try {
      r = await page.evaluate(
        ([name, f]) => window.probe(name, f),
        [`/${m.name}`, frames],
      );
    } catch (err) {
      failure ??= err instanceof Error ? err.message.split("\n")[0] : String(err);
    }
    const rss = treeRssMb(pid);
    const row = {
      width: m.width,
      modelMb: m.mb,
      seconds,
      frames,
      loadMs: r ? Math.round(r.loadMs) : 0,
      runMs: r ? Math.round(r.runMs) : 0,
      rate: r && r.runMs > 0 ? seconds / (r.runMs / 1000) : 0,
      rssMb: rss ? Math.round(rss) : null,
      threads: r?.threads ?? null,
      wallSec: ((Date.now() - t0) / 1000).toFixed(1),
      failure,
    };
    rows.push(row);
    console.log(
      `w=${row.width} (${row.modelMb.toFixed(1)}MB) ${seconds}s(${frames}f): ` +
        `load ${row.loadMs}ms / run ${row.runMs}ms(${row.rate.toFixed(2)}x) / ` +
        `RSS ${row.rssMb}MB / threads ${row.threads}` +
        (failure ? ` / ⚠ ${failure}` : ""),
    );
    await page.close();
    /* 失敗したらその width の長い尺はもう測らない（同じ理由で落ちるだけ）。 */
    if (failure) break;
  }
}

await browser.close();
server.close();
for (const m of models) rmSync(join(DIR, m.name), { force: true });

console.log("\n=== まとめ（Markdown） ===");
console.log("| モデル | 尺 | フレーム | セッション生成 | 推論 | 実時間比 | ブラウザ RSS |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  console.log(
    `| ${r.modelMb.toFixed(1)} MB | ${r.seconds}秒 | ${r.frames} | ${r.loadMs} ms | ` +
      `${r.failure ? "—" : `${r.runMs} ms`} | ${r.failure ? "—" : `${r.rate.toFixed(2)}x`} | ` +
      `${r.rssMb ?? "—"} MB |${r.failure ? ` ⚠ ${r.failure}` : ""}`,
  );
}
console.log(`\nbrowser idle RSS: ${idleRss?.toFixed(0)} MB`);
