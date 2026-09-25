import { expect, load, makeTone, setRange, test, type Page } from "./helpers";

/** プロジェクトのローカル保存・復元・削除（#18）と、自動保存・自動復元（#80）。 */

/**
 * 自動保存が実際に書き終わるまで待つ。成功時はログを出さない作り（黙って保存する
 * のが自動保存の趣旨）なので、副作用そのもの＝localStorage のメタを見る。
 */
async function waitAutoSaved(page: Page) {
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("prism-river.project")), {
      timeout: 15_000,
    })
    .not.toBeNull();
}

/* #18: プロジェクトの保存・復元。メタは localStorage、音声は IndexedDB。 */
test("プロジェクトを保存してリロード後に復元できる", async ({ page }) => {
  await load(page, [makeTone("keep1.wav", 440), makeTone("keep2.wav", 330, 3)]);

  /* 音量を 50 に変更（range は fill が効かないので setZoom と同じ手で入れる）。 */
  await page.getByLabel("keep1 の音量").evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");

  /* クリップを右へ 140px（既定ズーム 70px/s で 2 秒）動かす → 全長 4 秒。 */
  const box = await page.getByTestId("clip").first().boundingBox();
  if (!box) throw new Error("clip not found");
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, cy, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");

  /* keep1 に EQ LOW -6dB とコンプ ON を設定（#35: fx も保存対象）。 */
  await page.getByRole("button", { name: "keep1 のエフェクト", exact: true }).click();
  await setRange(page, "[data-testid=fx-low]", -6);
  await page.getByTestId("fx-comp").click();
  await expect(page.getByTestId("fxpanel")).toContainText("-6 dB");

  /* バスの割り当ても保存対象（#13）。 */
  await page.getByTestId("track-head").first().getByTestId("bus-keys").click();

  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  /* リロードすると、押さずとも前回の続きから開く（#80）。 */
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId("log")).toContainText("前回の続きから開きました");
  await expect(page.getByTestId("track-head").first()).toContainText("keep1");
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await expect(
    page.getByTestId("track-head").first().getByTestId("bus-keys"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
  await expect(page.getByTestId("probe-dec")).toContainText("ms");

  /* fx も復元されている（パネルの表示とコンプの ON 状態で確認）。 */
  await page.getByRole("button", { name: "keep1 のエフェクト", exact: true }).click();
  await expect(page.getByTestId("fxpanel")).toContainText("-6 dB");
  await expect(page.getByTestId("fx-comp")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "エフェクトを閉じる", exact: true }).click();

  /* 復元後も再生と書き出しが通る。 */
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect
    .poll(async () => page.getByTestId("clock-pos").textContent(), { timeout: 5000 })
    .not.toBe("00:00.00");
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

test("保存データを消すとリロード後は素の初期状態に戻る", async ({ page }) => {
  await load(page, [makeTone("wipe.wav", 440)]);
  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");

  await page.getByRole("button", { name: "保存データを消す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("保存データを削除しました");

  await page.reload();
  await expect(page.getByRole("button", { name: "前回を復元" })).toHaveCount(0);
  await expect(page.getByText("音声ファイルをここへドロップ")).toBeVisible();
  await expect(page.getByTestId("log")).not.toContainText("前回の続きから開きました");
});

/* #80 の本体: 保存を押していなくても、リロードで作業内容が戻る。 */
test("保存を押さなくても、編集した内容がリロード後に残る", async ({ page }) => {
  await load(page, [makeTone("auto1.wav", 440), makeTone("auto2.wav", 330, 3)]);
  await setRange(page, "[aria-label='auto1 の音量']", 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await waitAutoSaved(page);

  /* 「プロジェクトを保存」は一度も押していない。 */
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId("track-head").first()).toContainText("auto1");
  await expect(page.getByTestId("track-head").first()).toContainText("50");
});

/* 生成トラック（#54 / #55）は元ファイルが手元に無いので、失うと本当に戻せない。 */
test("打ち込んだドラムも、保存を押さずにリロードして戻る", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加" }).click();
  await page.getByTestId("drum-preset-empty").click();
  await page.getByTestId("drum-kick-5").click();
  await expect(page.getByTestId("drum-kick-5")).toHaveAttribute("aria-pressed", "true");
  await waitAutoSaved(page);

  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole("button", { name: /のドラム$/ }).click();
  await expect(page.getByTestId("drum-kick-5")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "false");
});

test("自動保存を切ると、編集はリロード後に残らない", async ({ page }) => {
  await load(page, [makeTone("off.wav", 440)]);
  await waitAutoSaved(page);

  await page.getByTestId("autosave").click();
  await expect(page.getByTestId("autosave")).toHaveAttribute("aria-pressed", "false");
  await setRange(page, "[aria-label='off の音量']", 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");

  /* 切ったあとの編集は書かれない（切る前の状態のまま戻る）。 */
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("track-head").first()).toContainText("85");
  /* 設定自体もリロードをまたいで残る。 */
  await expect(page.getByTestId("autosave")).toHaveAttribute("aria-pressed", "false");
});

/* 全部消したことは保存に反映しない。誤って消した作業が保存データごと消えるのを
   避けるための判断で、戻す道（「前回を復元」）が残ることまで含めて固定する。 */
test("トラックを全部消しても保存データは残り、前回を復元で戻せる", async ({ page }) => {
  await load(page, [makeTone("keepme.wav", 440)]);
  await waitAutoSaved(page);

  await page.getByTestId("track-head").first().click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("track-head")).toHaveCount(0);

  /* 削除も touched なので自動保存が予約される。その待ち時間（1.2秒）を過ぎても
     保存データが残っていることを見る——ここを待たないと、消す実装でも通ってしまう。 */
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => localStorage.getItem("prism-river.project"))).not.toBeNull();

  /* 空になっても保存は消えないので、ボタンが出て戻せる。 */
  await page.getByRole("button", { name: "前回を復元", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("track-head").first()).toContainText("keepme");
});

/* 壊れた保存データで起動できなくなるのが最悪なので、空で立ち上がって理由を出す。 */
test("保存データが壊れていても起動でき、理由が出る", async ({ page }) => {
  await load(page, [makeTone("broken.wav", 440)]);
  await waitAutoSaved(page);

  /* メタは残したまま音声だけ消す＝復元の途中で失敗する形にする。 */
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("prism-river");
        req.addEventListener("success", () => resolve());
        req.addEventListener("error", () => resolve());
        req.addEventListener("blocked", () => resolve());
      }),
  );

  await page.reload();
  await expect(page.getByTestId("log")).toContainText("復元に失敗しました", { timeout: 15_000 });
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  /* 起動はできているので、そのまま読み込み直せる。 */
  await load(page, [makeTone("again.wav", 440)]);
});
