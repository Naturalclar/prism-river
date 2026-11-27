import { readFileSync } from "node:fs";
import { expect, test, wavWindowHz, wavWindowPeak } from "./helpers";

/**
 * ピアノロールでの打ち込み（#55）。ドラム（#54）と同じく手ぶらで始められるので、
 * どのテストもファイルを読み込まない。「置いた」だけでなく、書き出した WAV の
 * 中身で**実際に音が出ている**ことを見る。
 */

/** C4（MIDI 60）のステップを押す。既定の長さは 2 ステップ。 */
async function putC4(page: import("@playwright/test").Page, step: number) {
  await page.getByTestId(`roll-60-${step}`).click();
  await expect(page.getByTestId(`roll-60-${step}`)).toHaveAttribute("aria-pressed", "true");
}

async function exportMix(page: import("@playwright/test").Page): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 20_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");
  return file;
}

test("打ち込みを追加すると空のロールが開く", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();

  await expect(page.getByTestId("track-head")).toHaveCount(1);
  await expect(page.getByTestId("rollpanel")).toBeVisible();
  /* 120BPM の1小節＝2.00 秒。音が無くても尺は保つ。 */
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  await expect(page.getByTestId("roll-60-0")).toHaveAttribute("aria-pressed", "false");
});

test("置いたノートが鳴り、置いていない区間は静か", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  /* 120BPM なので 1ステップ = 0.125s。先頭に C4 を1つだけ置く（長さ2＝0.25s）。 */
  await putC4(page, 0);

  const file = await exportMix(page);
  const head = wavWindowPeak(file, 0, 0.2);
  const gap = wavWindowPeak(file, 0.6, 1.9);
  expect(head).toBeGreaterThan(3000);
  expect(gap).toBeLessThan(head / 10);
});

test("ノートを消すと書き出しからも消える", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 0);
  await putC4(page, 8);

  const before = await exportMix(page);
  expect(wavWindowPeak(before, 1.0, 1.2)).toBeGreaterThan(3000);

  /* 8ステップ目（1.0s）の音だけ外す。 */
  await page.getByTestId("roll-60-8").click();
  await expect(page.getByTestId("roll-60-8")).toHaveAttribute("aria-pressed", "false");

  const after = await exportMix(page);
  expect(wavWindowPeak(after, 0, 0.2)).toBeGreaterThan(3000);
  expect(wavWindowPeak(after, 1.0, 1.2)).toBeLessThan(1000);
});

test("小節を増やすと格子が横に伸びる（ドラムのような繰り返しではない）", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  /* 1小節なので 16 ステップまで。17 個目はまだ無い。 */
  await expect(page.getByTestId("roll-60-15")).toBeVisible();
  await expect(page.getByTestId("roll-60-16")).toHaveCount(0);

  await page.locator("[data-testid=roll-bars]").evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, "2");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await expect(page.getByTestId("roll-60-31")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
});

test("保存してリロードするとノートごと復元される", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 5);

  await page.getByRole("button", { name: "プロジェクトを保存" }).click();
  await expect(page.getByTestId("log")).toContainText("保存しました", { timeout: 15_000 });

  await page.reload();
  /* リロードすると自動で戻る（#80）。 */
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 15_000 });

  /* ロールを開き直すと、置いた1音だけが残っている（音の正本がノート列なので、
     復元は再レンダーで通っている）。 */
  await page.getByRole("button", { name: /のロール$/ }).click();
  await expect(page.getByTestId("roll-60-5")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("roll-60-0")).toHaveAttribute("aria-pressed", "false");
});

test("打ち込みが2本あるとき、選択を変えるとロールもそのトラックに切り替わる（#76）", async ({ page }) => {
  /* ロールは画面下に固定で幅いっぱいに出るので、既定の 720px だと2本目のヘッドを覆う。
     ラックのヘッドを押せるよう縦を広げておく。 */
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(2);
  const heads = page.getByTestId("track-head");
  const title = page.getByTestId("rollpanel").locator(".fx-top b");

  /* 追加直後は新しい方（打ち込み 2）が開いていて、選択もそこにある。 */
  await expect(title).toHaveText("打ち込み 2");
  await expect(heads.nth(1)).toHaveClass(/selected/);
  /* 打ち込み 2 にだけ C4 を1つ置く。 */
  await putC4(page, 5);

  /* ラックで打ち込み 1 を選ぶと、ロールは空の打ち込み 1 になる。 */
  await heads.nth(0).locator(".head-name").click();
  await expect(title).toHaveText("打ち込み 1");
  await expect(page.getByTestId("roll-60-5")).toHaveAttribute("aria-pressed", "false");

  /* 戻すと、さっき置いた1音が残っている。 */
  await heads.nth(1).locator(".head-name").click();
  await expect(title).toHaveText("打ち込み 2");
  await expect(page.getByTestId("roll-60-5")).toHaveAttribute("aria-pressed", "true");

  /* 逆方向: R ボタンで開き直したトラックが選択になる。 */
  await heads.nth(0).getByRole("button", { name: /のロール$/ }).click();
  await expect(title).toHaveText("打ち込み 1");
  await expect(heads.nth(0)).toHaveClass(/selected/);
  await expect(heads.nth(1)).not.toHaveClass(/selected/);
});

/* #71: 音色ボタンは .tog（幅22px・1〜2文字想定）の流用で、「オルガン」等の
   複数文字ラベルが1文字ずつ折り返して縦にはみ出していた。折り返すと
   scrollHeight が1行ぶんを超えるので、機械的に検知できる。 */
test("音色・長さのボタンはラベルが1行に収まる", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加", exact: true }).click();
  await expect(page.getByTestId("rollpanel")).toBeVisible();
  const overflowing = await Promise.all(
    ["roll-tone-16", "roll-tone-0", "roll-len-8"].map(async (id) => {
      const fits = await page
        .getByTestId(id)
        .evaluate(
          (el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1,
        );
      return fits ? null : id;
    }),
  );
  expect(overflowing.filter(Boolean)).toEqual([]);
});

test("最新のノート列を移調し、再編集・復元後も同じWAVになる", async ({ page }) => {
  await page.setViewportSize({ width: 1450, height: 1000 });
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 0);
  await page.getByRole("button", { name: "ピアノロールを閉じる" }).click();
  await page.getByRole("button", { name: "打ち込み 1 の移調・テンポ" }).click();
  await page.getByTestId("stretch-pitch").press("End");
  await expect(page.getByTestId("stretch-pitch-val")).toHaveText("+12 半音");
  const first = await exportMix(page);
  expect(wavWindowPeak(first, 0, 0.2)).toBeGreaterThan(1000);
  const hz = wavWindowHz(first, 0.03, 0.18);
  expect(hz).toBeGreaterThan(490);
  expect(hz).toBeLessThan(555);
  await page.getByTestId("stretch-tempo-0.5").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
  await page.getByRole("button", { name: "ストレッチを閉じる" }).click();
  await page.getByRole("button", { name: "打ち込み 1 のロール" }).click();
  // 次のレンダーが終わる前にもう1音を置く。
  await page.evaluate(() => {
    for (const step of [4, 8]) document.querySelector<HTMLButtonElement>(`[data-testid=roll-60-${step}]`)!.click();
  });
  await expect(page.getByTestId("roll-60-4")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("roll-60-8")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".clock i")).toHaveText("/ 00:04.00");
  const edited = await exportMix(page);
  for (const sec of [0, 1, 2]) {
    expect(wavWindowPeak(edited, sec, sec + 0.2)).toBeGreaterThan(1000);
    const shifted = wavWindowHz(edited, sec + 0.08, sec + 0.28);
    expect(shifted).toBeGreaterThan(490);
    expect(shifted).toBeLessThan(555);
  }
  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("保存しました");
  await page.reload();
  await expect(page.getByTestId("track-head")).toHaveCount(1);
  expect(readFileSync(await exportMix(page)).equals(readFileSync(edited))).toBe(true);
  await page.getByRole("button", { name: "打ち込み 1 の移調・テンポ" }).click();
  await page.getByTestId("stretch-reset").click();
  await expect(page.locator(".clock i")).toHaveText("/ 00:02.00");
  const reset = await exportMix(page);
  const natural = wavWindowHz(reset, 1.03, 1.18);
  expect(natural).toBeGreaterThan(245);
  expect(natural).toBeLessThan(280);
});

test("移調中の編集は順に反映し、再計算失敗後も元の音から編集を続けられる", async ({ page }) => {
  await page.getByRole("button", { name: "打ち込みを追加" }).click();
  await putC4(page, 0);
  await page.getByRole("button", { name: "打ち込み 1 の移調・テンポ" }).click();
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    let count = 0;
    Worker.prototype.postMessage = function(data, transfer) {
      if (data.params && ++count === 2) {
        this.dispatchEvent(new MessageEvent("message", { data: { ok: false, error: "再計算失敗" } }));
        return;
      }
      if (data.params && count === 1) {
        setTimeout(() => Reflect.apply(send, this, [data, transfer]), 150);
      } else {
        Reflect.apply(send, this, [data, transfer]);
      }
    };
  });
  await page.getByTestId("stretch-pitch").press("End");
  await page.getByTestId("roll-60-8").click();
  await expect(page.getByTestId("log")).toContainText("再計算失敗");
  await expect(page.getByTestId("roll-60-8")).toHaveAttribute("aria-pressed", "false");
  const unchanged = await exportMix(page);
  expect(wavWindowPeak(unchanged, 0, 0.2)).toBeGreaterThan(1000);
  expect(wavWindowPeak(unchanged, 1, 1.2)).toBeLessThan(10);
  await putC4(page, 8);
  const repaired = await exportMix(page);
  const hz = wavWindowHz(repaired, 1.03, 1.18);
  expect(hz).toBeGreaterThan(490);
  expect(hz).toBeLessThan(555);
});

for (const width of [1450, 390]) {
  test(`TSとピアノロールを同時にクリックできる（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "打ち込みを追加" }).click();
    await page.getByRole("button", { name: "打ち込み 1 の移調・テンポ" }).click();
    await page.getByTestId("stretch-tempo-0.5").click();
    await expect(page.getByTestId("stretch-tempo-val")).toHaveText("0.50x");
    await putC4(page, 4);
    const roll = await page.getByTestId("rollpanel").boundingBox();
    const ts = await page.getByTestId("stretchpanel").boundingBox();
    if (!roll || !ts) throw new Error("panel missing");
    expect(roll.x + roll.width <= ts.x || roll.y + roll.height <= ts.y).toBe(true);
    await page.getByRole("button", { name: "ストレッチを閉じる" }).click();
    await expect(page.getByTestId("roll-60-4")).toHaveAttribute("aria-pressed", "true");
  });
}
