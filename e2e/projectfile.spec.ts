import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, load, makeTone, setRange, test, type Page } from "./helpers";
import { makeGarbage, putCopy } from "./fixture";
import { buildZip } from "../src/lib/zip";

/**
 * #81: プロジェクトを1ファイル（.prism・無圧縮 ZIP）に書き出す / 読み込む。
 * 端末内の保存データを消してから読み戻すことで、「ブラウザの外に持ち出せる」
 * ことを確かめる。
 */

/** 書き出し → ダウンロード → fixture に .prism として置き直す。 */
async function exportPrism(page: Page, name: string): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "プロジェクトを書き出す", exact: true }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe("prism-river-project.prism");
  const tmp = await d.path();
  if (!tmp) throw new Error("download path unavailable");
  await expect(page.getByTestId("log")).toContainText("プロジェクトを書き出しました");
  return putCopy(name, tmp);
}

/** 端末内の保存を消してリロードし、まっさらから始める。 */
async function wipeAndReload(page: Page) {
  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");
  await page.getByRole("button", { name: "保存データを消す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("保存データを削除しました");
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
}

test("書き出した .prism を読み込むとトラックと設定が戻り、書き出しも通る", async ({ page }) => {
  await load(page, [makeTone("pf1.wav", 440), makeTone("pf2.wav", 330, 3)]);
  await setRange(page, '[aria-label="pf1 の音量"]', 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await page.getByTestId("track-head").nth(1).getByTestId("bus-strings").click();

  const prism = await exportPrism(page, "roundtrip.prism");
  /* 他のツールでも開ける普通の ZIP（PK\x03\x04 で始まる）。 */
  const head = readFileSync(prism).subarray(0, 4);
  expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  await wipeAndReload(page);

  /* 音声と同じ入口（ピッカー）から読み込む。0本なので確認ダイアログは出ない。 */
  await page.setInputFiles("[data-testid=picker]", prism);
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId("log")).toContainText("roundtrip.prism を開きました");
  await expect(page.getByTestId("track-head").first()).toContainText("pf1");
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await expect(page.getByTestId("track-head").nth(1)).toContainText("pf2");
  await expect(
    page.getByTestId("track-head").nth(1).getByTestId("bus-strings"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");

  /* 戻したプロジェクトからミックスが書き出せる。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

/* 生成トラックは元ファイルが無く、パターンの JSON が音の正本。ここが往復すれば方式が正しい。 */
test("ドラムを含むプロジェクトが格子の中身ごと往復する", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加", exact: true }).click();
  await expect(page.getByTestId("drumpanel")).toBeVisible();
  await page.getByTestId("drum-kick-0").click();
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "false");

  const prism = await exportPrism(page, "drums.prism");
  await wipeAndReload(page);

  await page.setInputFiles("[data-testid=picker]", prism);
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toContainText("ドラム 1");
  await page.getByRole("button", { name: "ドラム 1 のドラム", exact: true }).click();
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("drum-kick-4")).toHaveAttribute("aria-pressed", "true");
});

test("壊れたファイル・新しい版のファイルは理由の分かる文言で断る", async ({ page }) => {
  await page.setInputFiles("[data-testid=picker]", makeGarbage("junk.prism"));
  await expect(page.getByTestId("log")).toContainText("junk.prism: プロジェクトファイルとして読めません");
  await expect(page.getByTestId("track-head")).toHaveCount(0);

  /* 将来の版で保存されたファイル。ZIP としては正しいので、版の文言で断る。 */
  const dir = mkdtempSync(join(tmpdir(), "prism-"));
  const future = join(dir, "future.prism");
  writeFileSync(
    future,
    buildZip([
      {
        name: "project.json",
        data: new TextEncoder().encode(JSON.stringify({ version: 99, tracks: [] })),
      },
    ]),
  );
  await page.setInputFiles("[data-testid=picker]", putCopy("future.prism", future));
  await expect(page.getByTestId("log")).toContainText("新しい版（v99）で保存されています");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
});

test("トラックがあるときの読み込みは確認し、やめれば今の内容が残る", async ({ page }) => {
  await load(page, [makeTone("keep.wav", 440)]);
  const prism = await exportPrism(page, "one.prism");
  await page.setInputFiles("[data-testid=picker]", makeTone("extra.wav", 550));
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  /* やめる → 2本のまま。 */
  page.once("dialog", (d) => void d.dismiss());
  await page.setInputFiles("[data-testid=picker]", prism);
  await expect(page.getByTestId("log")).toContainText("読み込みをやめました");
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  /* 続ける → ファイルの1本に置き換わる。 */
  page.once("dialog", (d) => void d.accept());
  await page.setInputFiles("[data-testid=picker]", prism);
  await expect(page.getByTestId("log")).toContainText("one.prism を開きました", { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("track-head")).toContainText("keep");
});
