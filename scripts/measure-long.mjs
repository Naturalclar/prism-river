/**
 * 長尺・複数トラックの実測（#21）。
 *
 * 「5分・10分の曲を複数トラック読ませたときのメモリとデコード時間。どこで破綻するか」
 * を測る。結果は README の計測節に載せる。
 *
 *   pnpm build && pnpm preview --port 4173 --strictPort --host 127.0.0.1 &
 *   node scripts/measure-long.mjs
 *
 * ブラウザは Playwright のもの。別の Chromium を使うなら CHROMIUM_PATH で指す。
 */

/* 計測なので直列実行が要件。並列にすると読み込み時間もメモリのピークも
   混ざって、測りたい「1構成ぶんの値」が出なくなる。 */
// oxlint-disable no-await-in-loop
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.MEASURE_URL ?? "http://127.0.0.1:4173/";
const DIR = join(process.cwd(), "test-results", "long");
const SR = 44100;

/* 測る組み合わせ。トラック数は破綻点を跨ぐように倍々で伸ばす。
   破綻点を追い込むときは MEASURE_MINUTES=10 MEASURE_TRACKS=16,24,32 で上書きする。 */
const PLAN =
  process.env.MEASURE_MINUTES && process.env.MEASURE_TRACKS
    ? [
        {
          minutes: Number(process.env.MEASURE_MINUTES),
          tracks: process.env.MEASURE_TRACKS.split(",").map(Number),
        },
      ]
    : [
        { minutes: 5, tracks: [1, 2, 4, 8] },
        { minutes: 10, tracks: [1, 2, 4, 8] },
      ];

/** 減衰トーンの WAV を書く。中身は e2e/fixture.ts と同じ作り方（int16 ステレオ）。 */
function writeTone(path, hz, seconds) {
  const n = seconds * SR;
  const header = Buffer.alloc(44);
  const dataBytes = n * 2 * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);

  /* 1秒ずつ書いて、生成側でメモリを抱えないようにする。 */
  const chunk = Buffer.alloc(SR * 4);
  const parts = [header];
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < SR; i++) {
      const t = (s * SR + i) / SR;
      const env = Math.exp(-6 * (t % 0.5));
      const v = Math.sin(2 * Math.PI * hz * t) * env * 0.7;
      chunk.writeInt16LE(Math.round(v * 32767), i * 4);
      chunk.writeInt16LE(Math.round(v * 0.6 * 32767), i * 4 + 2);
    }
    parts.push(Buffer.from(chunk));
  }
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

/** ブラウザのプロセスツリー全体の RSS（MB）。PCM は JS ヒープの外にも乗るのでこれで見る。 */
function treeRssMb(pid) {
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,rss"], { encoding: "utf8" });
    const rows = out
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp, rss] of rows) {
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push({ pid: p, rss });
    }
    let total = 0;
    const walk = (p) => {
      const self = rows.find((r) => r[0] === p);
      if (self) total += self[2];
      for (const k of kids.get(p) ?? []) walk(k.pid);
    };
    walk(pid);
    return total / 1024;
  } catch {
    return null;
  }
}

const text = async (page, id) => (await page.getByTestId(`probe-${id}`).textContent()) ?? "";
const num = (s) => Number.parseFloat(s.replace(/[^0-9.]/g, "")) || 0;

/** 起動中の Chromium のうち、--type 指定が無いもの（＝ブラウザ本体）の pid。 */
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

const rows = [];
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
/* Playwright のバージョンによっては browser.process() が無いので、
   起動済みブラウザの親 pid を実行ファイル名から引く。 */
const pid = findBrowserPid();
const idleRss = pid ? treeRssMb(pid) : null;
console.log(`browser idle RSS: ${idleRss?.toFixed(0)} MB`);

for (const { minutes, tracks } of PLAN) {
  const seconds = minutes * 60;
  const max = Math.max(...tracks);
  console.log(`\n=== ${minutes}分 の音源を ${max} 本まで生成中 …`);
  const files = [];
  for (let i = 0; i < max; i++) {
    files.push(writeTone(join(DIR, `long-${minutes}m-${i}.wav`), 220 + i * 55, seconds));
  }

  for (const n of tracks) {
    const page = await browser.newPage();
    let failure = null;
    page.on("pageerror", (e) => (failure ??= `pageerror: ${e.message}`));
    page.on("crash", () => (failure ??= "renderer crash"));
    await page.goto(BASE);

    const t0 = Date.now();
    let decodeMs = 0;
    let ramMb = 0;
    let renderMs = 0;
    let rss = null;
    try {
      await page.setInputFiles("[data-testid=picker]", files.slice(0, n));
      await page.getByTestId("track-head").nth(n - 1).waitFor({ timeout: 300_000 });
      decodeMs = num(await text(page, "dec"));
      ramMb = num(await text(page, "ram"));
      rss = treeRssMb(pid);

      await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
      await page
        .getByTestId("log")
        .filter({ hasText: /書き出しました|失敗/ })
        .waitFor({ timeout: 600_000 });
      const log = await page.getByTestId("log").textContent();
      if (/失敗/.test(log ?? "")) failure ??= `bounce: ${log}`;
      renderMs = num(await text(page, "off"));
    } catch (err) {
      failure ??= err instanceof Error ? err.message.split("\n")[0] : String(err);
    }

    const row = {
      minutes,
      tracks: n,
      totalMin: (minutes * n).toFixed(0),
      decodeMs,
      ramMb,
      renderMs,
      renderX: renderMs ? Math.round(seconds / (renderMs / 1000)) : 0,
      rssMb: rss ? Math.round(rss) : null,
      wallSec: ((Date.now() - t0) / 1000).toFixed(1),
      failure,
    };
    rows.push(row);
    console.log(
      `${minutes}分 × ${n}本: デコード ${row.decodeMs}ms / PCM ${row.ramMb}MB / RSS ${row.rssMb}MB / ` +
        `レンダー ${row.renderMs}ms(${row.renderX}x) / 実時間 ${row.wallSec}s` +
        (failure ? ` / ⚠ ${failure}` : ""),
    );
    await page.close();
  }

  for (const f of files) rmSync(f, { force: true });
}

await browser.close();
console.log("\n=== まとめ（Markdown） ===");
console.log("| 尺 × 本数 | 総再生分 | デコード | PCM メモリ | ブラウザ RSS | オフラインレンダー |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const note = r.failure ? ` ⚠ ${r.failure}` : "";
  console.log(
    `| ${r.minutes}分 × ${r.tracks} | ${r.totalMin}分 | ${r.decodeMs} ms | ${r.ramMb} MB | ${r.rssMb} MB | ${r.renderMs} ms＝約${r.renderX}倍速${note} |`,
  );
}
