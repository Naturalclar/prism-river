import { expect, load, makeTone, test, wavWindowPeak } from "./helpers";

/** クリップの編集操作: 選択と削除・移動を除くドラッグ系（トリム・フェード）。 */

test("クリックで選択したトラックを Delete で削除できる", async ({ page }) => {
  await load(page, [makeTone("sel1.wav", 440), makeTone("sel2.wav", 330)]);

  /* クリップのクリックで選択（枠が付く）。 */
  await page.getByTestId("clip").first().click();
  await expect(page.getByTestId("clip").first()).toHaveClass(/selected/);
  await expect(page.getByTestId("track-head").first()).toHaveClass(/selected/);

  /* Delete で選択中のトラックだけ消える。 */
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("track-head")).toContainText("sel2");

  /* 選択が無い状態の Delete では何も起きない。 */
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("track-head")).toHaveCount(1);

  /* 同じトラックの再クリックで選択が外れる。 */
  await page.getByTestId("clip").click();
  await expect(page.getByTestId("clip")).toHaveClass(/selected/);
  await page.getByTestId("clip").click();
  await expect(page.getByTestId("clip")).not.toHaveClass(/selected/);
});

test("クリップの左右端ドラッグでトリムできる", async ({ page }) => {
  await load(page, [makeTone("trim.wav", 440, 3)]);
  const before = await page.getByTestId("clip").boundingBox();
  if (!before) throw new Error("clip not found");

  /* 右端を 70px（既定ズームで 1 秒）左へ → 全長が 2 秒になる。 */
  const y = before.y + before.height / 2;
  await page.mouse.move(before.x + before.width - 4, y);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 4 - 70, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  const trimmed = await page.getByTestId("clip").boundingBox();
  if (!trimmed) throw new Error("clip not found");
  expect(trimmed.width).toBeLessThan(before.width - 60);

  /* 左端を 35px（0.5 秒）右へ → 頭が削れて開始位置がその分ずれる。
     offset が連動するので全長（0.5 + 1.5 = 2 秒）は変わらない。 */
  await page.mouse.move(trimmed.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(trimmed.x + 4 + 35, y, { steps: 5 });
  await page.mouse.up();
  const headTrimmed = await page.getByTestId("clip").boundingBox();
  if (!headTrimmed) throw new Error("clip not found");
  expect(headTrimmed.x - trimmed.x).toBeGreaterThan(30);
  expect(headTrimmed.width).toBeLessThan(trimmed.width - 30);
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");

  /* トリム後も再生と書き出しが通る。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("prism-river-mix.wav");
});

test("フェードアウトが書き出しに効く", async ({ page }) => {
  await load(page, [makeTone("fade.wav", 440, 2)]);
  const box = await page.getByTestId("clip").boundingBox();
  if (!box) throw new Error("clip not found");

  /* 右上のフェードハンドルを左端までドラッグ → フェードアウト 2 秒。 */
  const hx = box.x + box.width - 3;
  const hy = box.y + 5;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 140, hy, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("log")).toContainText("アウト 2.00s");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  /* 音源は 0.5s ごとに同じ振幅でアタックを打ち直すので、素の書き出しなら
     0.5s 付近と 1.5s 付近のピークはほぼ同じ。線形フェードアウトが効いて
     いれば 1.5s 時点のゲインは 0.25 になり、比がはっきり開く。 */
  const head = wavWindowPeak(file, 0.45, 0.65);
  const tail = wavWindowPeak(file, 1.45, 1.65);
  expect(head).toBeGreaterThan(3000);
  expect(tail).toBeLessThan(head * 0.5);
});

/* #66: クリップ移動のスナップ。既定ズーム 70px/s・しきい値 8px（約0.11s）。 */
test("移動中に他クリップの端へスナップし、Shift で切れる", async ({ page }) => {
  /* a は 2 秒。b(1秒) を a の終端（2.00s）の少し手前までドラッグする。 */
  await load(page, [makeTone("snapA.wav", 440, 2), makeTone("snapB.wav", 330, 1)]);
  const clipB = page.getByTestId("clip").nth(1);
  const box = await clipB.boundingBox();
  if (!box) throw new Error("clip not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  /* +136px（= 1.94s 相当）。しきい値内なので 2.00s に吸着し、枠色が変わる。 */
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 136, cy, { steps: 5 });
  await expect(clipB).toHaveClass(/snapped/);
  await page.mouse.up();
  await expect(clipB).not.toHaveClass(/snapped/);
  await expect(page.getByTestId("log")).toContainText("snapB の開始位置: 2.00s");

  /* Shift ドラッグはスナップしない: 2.00s から +5px（≒0.07s）動かすと端数のまま。 */
  const moved = await clipB.boundingBox();
  if (!moved) throw new Error("clip not found");
  const mx = moved.x + moved.width / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(mx, cy);
  await page.mouse.down();
  await page.mouse.move(mx + 5, cy, { steps: 2 });
  await expect(clipB).not.toHaveClass(/snapped/);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("log")).toContainText("snapB の開始位置: 2.07s");

  /* 0 秒にも吸着する: 先頭付近まで戻すとぴったり 0.00s。 */
  const back = await clipB.boundingBox();
  if (!back) throw new Error("clip not found");
  const bx = back.x + back.width / 2;
  await page.mouse.move(bx, cy);
  await page.mouse.down();
  await page.mouse.move(bx - Math.round(2.07 * 70) + 4, cy, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("log")).toContainText("snapB の開始位置: 0.00s");
});

/* #77: トラックの複製。設定ごと写り、複製側が選択される。 */
test("選択したトラックを Ctrl+D で複製できる", async ({ page }) => {
  await load(page, [makeTone("dup.wav", 440, 2)]);

  /* 音量を 50 に変えてから複製 → 複製側にも 50 が写る。 */
  await page.getByLabel("dup の音量").evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");

  await page.getByTestId("clip").click();
  await page.keyboard.press("Control+d");
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  await expect(page.getByTestId("track-head").nth(1)).toContainText("dup のコピー");
  await expect(page.getByTestId("track-head").nth(1)).toContainText("50");
  /* 複製側が選択されている。 */
  await expect(page.getByTestId("clip").nth(1)).toHaveClass(/selected/);

  /* 選択を外すと Ctrl+D は何もしない。 */
  await page.getByTestId("clip").nth(1).click();
  await expect(page.getByTestId("clip").nth(1)).not.toHaveClass(/selected/);
  await page.keyboard.press("Control+d");
  await expect(page.getByTestId("track-head")).toHaveCount(2);
});

/* パターンはディープコピー: 複製側の格子を編集しても元は変わらない。 */
test("ドラムトラックの複製は元と独立して編集できる", async ({ page }) => {
  await page.getByRole("button", { name: "ドラムを追加", exact: true }).click();
  await expect(page.getByTestId("drumpanel")).toBeVisible();
  const title = page.getByTestId("drumpanel").locator(".fx-top b");

  /* 追加したトラックは選択済み（#76）。ボタンにフォーカスが残っているとキーが
     素通りするので、何も起きない場所を押してフォーカスを外してから Ctrl+D。 */
  await expect(page.getByTestId("clip")).toHaveClass(/selected/);
  await page.locator(".rack-top").click();
  await page.keyboard.press("Control+d");
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  /* 選択は複製側へ移り、開いたままのパネルも追従する（#76）。四つ打ちのキック1拍目を消す。 */
  await expect(title).toHaveText("ドラム 1 のコピー");
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("drum-kick-0").click();
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "false");

  /* 元トラックのパネルに切り替えると、キック1拍目は残っている。 */
  await page.getByRole("button", { name: "ドラム 1 のドラム", exact: true }).click();
  await expect(title).toHaveText("ドラム 1");
  await expect(page.getByTestId("drum-kick-0")).toHaveAttribute("aria-pressed", "true");
});
