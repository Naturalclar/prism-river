import { readFileSync, statSync } from "node:fs";
import { expect, load, makeTone, setRange, test } from "./helpers";

/** ミックスの書き出し（WAV / webm）と保存経路の失敗からの復帰。 */

test("ミックスを書き出すとオフラインレンダーの計測値が出る", async ({ page }) => {
  await load(page, [makeTone("mix1.wav", 440), makeTone("mix2.wav", 550)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();

  await expect(page.getByTestId("probe-off")).toContainText("ms", { timeout: 15_000 });
  await expect(page.getByTestId("log")).toContainText("書き出しました");
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");

  /* レンダーは実時間より十分速いこと（v0 の実測は約323倍速）。 */
  const ms = Number.parseFloat((await page.getByTestId("probe-off").textContent()) ?? "0");
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(2000);
});

/* 保存経路が失敗しても bouncing が戻り、ボタンが使える状態に復帰する回帰。
   （Artifact ビューアで capability 取得が reject するケースの再現） */
test("保存に失敗しても書き出しボタンは無効のままにならない", async ({ page }) => {
  await page.addInitScript(() => {
    window.claude = { use: () => Promise.reject(new Error("downloads unavailable")) };
  });
  await page.goto("/");
  await load(page, [makeTone("stuck.wav", 440)]);

  const bounce = page.getByRole("button", { name: "ミックスを書き出す", exact: true });
  await bounce.click();
  await expect(page.getByTestId("probe-off")).toContainText("ms", { timeout: 15_000 });
  await expect(bounce).toBeEnabled();
  await expect(page.getByTestId("log")).toContainText("ファイル保存が使えない");
  /* afterEach の「ページ例外ゼロ」も本テストの検証対象:
     修正前は use() の reject が unhandled rejection になっていた。 */
});

/* #49: 書き出したあとに編集すると、レンダー結果はもう今のミックスではない。
   「レンダーを試聴」が古い音を黙って鳴らしていた回帰。音に効かない変更
   （ズーム）では捨てないことも、同じテストで固定しておく。 */
test("編集するとレンダー結果は捨てられ、表示だけの変更では残る", async ({ page }) => {
  await load(page, [makeTone("stale1.wav", 440), makeTone("stale2.wav", 330)]);
  const audition = page.getByRole("button", { name: /レンダーを試聴/ });

  const first = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(audition).toBeVisible({ timeout: 15_000 });
  await first;

  /* ズームは波形の見え方だけなので、レンダー結果はそのまま使える。 */
  await setRange(page, "#zoom", 200);
  await expect(audition).toBeVisible();

  /* トラックを消すと、その音を含んだレンダーは今のミックスと違う。 */
  await page.getByRole("button", { name: /を削除/ }).first().click();
  await expect(audition).toHaveCount(0);

  /* 音量のような「消さない編集」でも同じこと。 */
  const second = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(audition).toBeVisible({ timeout: 15_000 });
  await second;
  await setRange(page, "#mVol", 0.4);
  await expect(audition).toHaveCount(0);
});

/* webm はオフラインの一括レンダーと違い、実時間で再生しながら録る（仕様）。
   テスト音源を短く保つのはそのため。 */
test("webm 書き出しで Opus のファイルが降りてくる", async ({ page }) => {
  await load(page, [makeTone("wm.wav", 440, 2)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "webm で書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("webm を書き出しました", {
    timeout: 20_000,
  });

  const d = await download;
  expect(d.suggestedFilename()).toBe("prism-river-mix.webm");
  const file = await d.path();
  if (!file) throw new Error("download path unavailable");
  expect(statSync(file).size).toBeGreaterThan(1000);
  /* WebM (Matroska) のマジックナンバー 0x1A45DFA3 で始まっている。 */
  const head = readFileSync(file).subarray(0, 4);
  expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

  await expect(page.getByTestId("probe-webm")).toContainText("実時間");
});

/* #20: MP3（LAME / WASM）のオフライン書き出し。webm と違い実時間はかからない。 */
test("MP3 で書き出すと WASM エンコードの計測値が出る", async ({ page }) => {
  await load(page, [makeTone("mp1.wav", 440, 3), makeTone("mp2.wav", 550, 3)]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "MP3 で書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MP3 を書き出しました", { timeout: 20_000 });

  const d = await download;
  expect(d.suggestedFilename()).toBe("prism-river-mix.mp3");
  const file = await d.path();
  if (!file) throw new Error("download path unavailable");
  const bytes = readFileSync(file);

  /* ヘッダ: ID3v2 タグ、または MPEG フレーム同期（0xFF + 上位3bit）。 */
  const sync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  const id3 = bytes.subarray(0, 3).toString() === "ID3";
  expect(sync || id3).toBe(true);

  /* CBR 192kbps の3秒 ≈ 72KB。同じ尺の WAV（≈0.5MB）より桁で小さい。 */
  expect(bytes.length).toBeGreaterThan(40_000);
  expect(bytes.length).toBeLessThan(150_000);

  /* エンコード時間のテレメトリが埋まり、実時間より速い（=1倍超）と表示される。 */
  await expect(page.getByTestId("probe-mp3")).toContainText("ms");
  await expect(page.getByTestId("probe-mp3")).toContainText("倍速");
});
