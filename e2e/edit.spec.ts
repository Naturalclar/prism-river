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

/* #84: トリムのスナップ。移動（#66）と同じ流儀で、他クリップの端に吸着する。
   トリムは素材の全長までしか伸ばせないので、**縮める**方向で吸着させる。 */

/** 2本目を右へ 4 秒ぶん動かす（既定ズーム 70px/s）。戻り値は1本目のクリップ。 */
async function layout(page: import("@playwright/test").Page) {
  const second = page.getByTestId("clip").nth(1);
  const b0 = await second.boundingBox();
  if (!b0) throw new Error("clip not found");
  const by = b0.y + b0.height / 2;
  await page.mouse.move(b0.x + b0.width / 2, by);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width / 2 + 280, by, { steps: 6 });
  await page.mouse.up();
  return { first: page.getByTestId("clip").first(), second };
}

test("右端のトリムが隣のクリップの開始位置にスナップする", async ({ page }) => {
  /* 1本目は 0〜6秒。2本目を 4秒 に置き、そこをスナップ点にする。 */
  await load(page, [makeTone("snapA.wav", 440, 6), makeTone("snapB.wav", 330, 2)]);
  const { first, second } = await layout(page);

  /* 1本目の右端（6秒）を 4秒 の少し手前まで縮める。ぴったり 140px 縮めると
     目分量でも一致してしまうので、4px 足りない位置で離す。 */
  const a0 = await first.boundingBox();
  if (!a0) throw new Error("clip not found");
  const ay = a0.y + a0.height / 2;
  await page.mouse.move(a0.x + a0.width - 4, ay);
  await page.mouse.down();
  await page.mouse.move(a0.x + a0.width - 4 - 136, ay, { steps: 6 });
  /* 吸着中は枠色が変わる（移動と同じ .snapped）。 */
  await expect(first).toHaveClass(/snapped/);
  await page.mouse.up();

  /* 4秒ちょうどで止まっていれば、2本目の開始と隙間なく繋がっている。 */
  const a1 = await first.boundingBox();
  const b1 = await second.boundingBox();
  if (!a1 || !b1) throw new Error("clip not found");
  expect(Math.abs(a1.x + a1.width - b1.x)).toBeLessThan(1);
});

test("Shift ドラッグならトリムは吸着しない", async ({ page }) => {
  await load(page, [makeTone("nosnapA.wav", 440, 6), makeTone("nosnapB.wav", 330, 2)]);
  const { first, second } = await layout(page);

  const a0 = await first.boundingBox();
  if (!a0) throw new Error("clip not found");
  const ay = a0.y + a0.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(a0.x + a0.width - 4, ay);
  await page.mouse.down();
  await page.mouse.move(a0.x + a0.width - 4 - 136, ay, { steps: 6 });
  await expect(first).not.toHaveClass(/snapped/);
  await page.mouse.up();
  await page.keyboard.up("Shift");

  /* 吸着しないので、離した位置のまま（このドラッグ量では 4px 行き過ぎて重なる）。
     符号は問わず「隣の端に揃っていない」ことを見る。 */
  const a1 = await first.boundingBox();
  const b1 = await second.boundingBox();
  if (!a1 || !b1) throw new Error("clip not found");
  expect(Math.abs(b1.x - (a1.x + a1.width))).toBeGreaterThan(1);
});
