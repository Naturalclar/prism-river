/**
 * OGP 画像（public/ogp.png）を作る（#69）。
 *
 *   pnpm ogp
 *
 * scripts/ogp/template.html を 1200x630 で開いてスクリーンショットを撮るだけ。
 * 外部の画像素材は持ち込まず、波形もトラックもテンプレート側の CSS で描く
 * （このリポジトリはドラム音源も合成で作って「増えるバイト数はゼロ」を通している）。
 *
 * 生成物はコミットする。ビルドのたびにブラウザを起動するのは重く、CI に
 * ブラウザ依存を増やすことになるため、再生成は手で叩く運用にしている。
 *
 * ブラウザは Playwright のもの（E2E で既に入っている）。別の Chromium を
 * 使うなら CHROMIUM_PATH で指す。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** OGP の推奨サイズ。template.html の body と一致させること。 */
const WIDTH = 1200;
const HEIGHT = 630;

const OUT = join(ROOT, "public", "ogp.png");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.goto(pathToFileURL(join(HERE, "template.html")).href);
  /* Web フォントが乗る前に撮ると、字面が別物になる。 */
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT} (${WIDTH}x${HEIGHT})`);
} finally {
  await browser.close();
}
