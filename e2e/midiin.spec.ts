import { expect, test, wavWindowPeak } from "./helpers";

/**
 * #56: MIDI 実機入力。実機は CI に無いので、`navigator.requestMIDIAccess` を
 * フェイクに差し替えて note on/off を流し込む（`export.spec.ts` が
 * `window.claude` を差し替えているのと同じ流儀）。実機との突き合わせは
 * README の対応表（#22 / #23 の並び）で追う。
 */

declare global {
  interface Window {
    midiFire?: (data: number[]) => void;
  }
}

/** 入力ポート1つの MIDIAccess フェイクを仕込む。midiFire でイベントを流せる。 */
async function fakeMidi(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const listeners = new Set<(e: unknown) => void>();
    const input = {
      id: "fake",
      name: "Fake Keys",
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === "midimessage") listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (e: unknown) => void) => {
        listeners.delete(fn);
      },
    };
    window.midiFire = (data: number[]) => {
      for (const fn of listeners) {
        fn({ data: new Uint8Array(data), timeStamp: performance.now() });
      }
    };
    (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = () =>
      Promise.resolve({ inputs: new Map([["fake", input]]) });
  });
  await page.goto("/");
}

test("MIDI キーボードで弾いて録るとトラックになり、弾いた音程で鳴る", async ({ page }) => {
  await fakeMidi(page);

  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MIDI 録音中（入力: Fake Keys）");

  /* A4 (440Hz) を約0.5秒弾く。受信カウントが出ることも確かめる。 */
  await page.evaluate(() => window.midiFire?.([0x90, 69, 100]));
  await expect(page.getByTestId("log")).toContainText("受信 1音");
  await page.waitForTimeout(500);
  await page.evaluate(() => window.midiFire?.([0x80, 69, 0]));

  await page.getByRole("button", { name: "MIDI 録音を停止", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toContainText("MIDI 録音 1");
  await expect(page.getByTestId("log")).toContainText("MIDI 録音 1 — 1音");
  await expect(page.getByTestId("clip")).toHaveCount(1);

  /* 弾いた音程で実際に鳴る: 書き出した WAV にトーンのピークが立つ。 */
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("書き出しました", { timeout: 15_000 });
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");
  expect(wavWindowPeak(file, 0, 10)).toBeGreaterThan(3000);
});

test("MIDI 録音は保存 → リロード → 復元で戻る", async ({ page }) => {
  await fakeMidi(page);
  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MIDI 録音中");
  await page.evaluate(() => window.midiFire?.([0x90, 60, 100]));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.midiFire?.([0x80, 60, 0]));
  await page.getByRole("button", { name: "MIDI 録音を停止", exact: true }).click();
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });

  /* srcBytes のノート列 JSON から再レンダーされて戻る。 */
  await page.getByRole("button", { name: "プロジェクトを保存", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("プロジェクトを保存しました");
  await page.reload();
  /* リロードすると自動で戻る（#80）。 */
  await expect(page.getByTestId("track-head")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("track-head")).toContainText("MIDI 録音 1");
});

test("何も弾かずに停止するとトラックは作らない", async ({ page }) => {
  await fakeMidi(page);
  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MIDI 録音中");
  await page.getByRole("button", { name: "MIDI 録音を停止", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("トラックは作りません");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
});

test("MIDI の権限が拒否されたら分かるメッセージが出る", async ({ page }) => {
  await page.addInitScript(() => {
    (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MIDI の使用が許可されませんでした");
  /* 録音状態にはならず、ボタンは再試行できる姿のまま。 */
  await expect(
    page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }),
  ).toBeVisible();
});

test("Web MIDI 非対応ブラウザでは分かる文言で伝える", async ({ page }) => {
  /* 非対応ブラウザ（Safari 相当）。 */
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "requestMIDIAccess", { value: undefined, configurable: true });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("Web MIDI API に対応していません");
});

test("MIDI 入力デバイスが無いときは繋いでからと伝える", async ({ page }) => {
  await page.addInitScript(() => {
    (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = () =>
      Promise.resolve({ inputs: new Map() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "MIDI キーボードから録音", exact: true }).click();
  await expect(page.getByTestId("log")).toContainText("MIDI 入力デバイスが見つかりませんでした");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
});
