import { expect, load, makeTone, setRange, test, wavWindowPeak } from "./helpers";

/** グループバス（弦 / 管 / 鍵盤 の3系統サブミックス）。 */

/* #13: グループバス。2トラックを別バスへ割り当て、一方のバス音量を 0 にして
   書き出すと、そのバスのトラックだけがレンダーから消えることを確かめる。 */
test("トラックをバスに割り当てるとバス音量が書き出しに効く", async ({ page }) => {
  /* busA は 2 秒・busB は 1 秒。後半 1 秒は busA しか鳴らない区間になる。 */
  await load(page, [makeTone("busA.wav", 440, 2), makeTone("busB.wav", 330, 1)]);

  /* 割り当て: busA → 弦（ルナサ）、busB → 管（メルラン）。 */
  const headA = page.getByTestId("track-head").nth(0);
  const headB = page.getByTestId("track-head").nth(1);
  await headA.getByTestId("bus-strings").click();
  await expect(headA.getByTestId("bus-strings")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("log")).toContainText("busA → 弦バス（ルナサ）");
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "true");

  /* もう一度押すと外れて Master 直結に戻り、押し直せる（トグル）。 */
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("log")).toContainText("Master 直結");
  await headB.getByTestId("bus-winds").click();
  await expect(headB.getByTestId("bus-winds")).toHaveAttribute("aria-pressed", "true");

  /* 弦バスのフェーダーを 0 へ。 */
  await setRange(page, "#busvol-strings", 0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ミックスを書き出す", exact: true }).click();
  const file = await (await download).path();
  if (!file) throw new Error("download path unavailable");

  /* 前半: 管バスの busB は生きている。 */
  expect(wavWindowPeak(file, 0.2, 0.45)).toBeGreaterThan(3000);
  /* 後半: busA だけの区間。弦バスが 0 なので無音になる。 */
  expect(wavWindowPeak(file, 1.2, 1.8)).toBeLessThan(200);
});
