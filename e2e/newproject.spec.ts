import { expect, load, makeTone, setRange, test, type Page } from "./helpers";
import { putCopy } from "./fixture";

/**
 * #96: 「新規プロジェクト」と「プロジェクトを読み込む」。
 * 新規は端末内の保存データごと消す（自動保存は 0 本では書かないので、消すだけ
 * だとリロードで前のプロジェクトが戻ってくる）。
 */

async function exportPrism(page: Page, name: string): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "プロジェクトを書き出す", exact: true }).click();
  const tmp = await (await download).path();
  if (!tmp) throw new Error("download path unavailable");
  await expect(page.getByTestId("log")).toContainText("プロジェクトを書き出しました");
  return putCopy(name, tmp);
}

const newButton = (page: Page) => page.getByRole("button", { name: "新規プロジェクト", exact: true });

test("新規プロジェクトは確認してから全部消し、やめれば残る", async ({ page }) => {
  /* 何も無く保存も無いときは押せない。 */
  await expect(newButton(page)).toBeDisabled();

  await load(page, [makeTone("np1.wav", 440), makeTone("np2.wav", 330, 3)]);
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");

  page.once("dialog", (d) => {
    expect(d.message()).toContain("トラック 2 本を消します");
    void d.dismiss();
  });
  await newButton(page).click();
  await expect(page.getByTestId("log")).toContainText("新規プロジェクトをやめました");
  await expect(page.getByTestId("track-head")).toHaveCount(2);

  page.once("dialog", (d) => void d.accept());
  await newButton(page).click();
  await expect(page.getByTestId("log")).toContainText("新規プロジェクトを始めました（トラック 2 本を消しました）");
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.locator(".clock i")).toHaveText("/ 00:00.00");
  await expect(newButton(page)).toBeDisabled();
});

test("新規プロジェクトのあとリロードしても前のプロジェクトは戻らない", async ({ page }) => {
  await load(page, [makeTone("np3.wav", 440)]);
  /* 自動保存（既定 ON）が書き終わるのを待つ。 */
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("prism-river.project")), {
      timeout: 15_000,
    })
    .not.toBeNull();

  page.once("dialog", (d) => {
    expect(d.message()).toContain("端末内の保存データも消します");
    void d.accept();
  });
  await newButton(page).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("prism-river.project"))).toBeNull();

  /* 保存が無いので起動時の自動復元も走らず、「前回を復元」も出ない。 */
  await page.reload();
  await expect(newButton(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "前回を復元", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("track-head")).toHaveCount(0);
  await expect(page.getByTestId("log")).not.toContainText("前回の続きから開きました");
});

test("「プロジェクトを読み込む」は .prism だけを受け、書き出したものが戻る", async ({ page }) => {
  await expect(page.getByTestId("project-picker")).toHaveAttribute("accept", ".prism");

  await load(page, [makeTone("np4.wav", 440), makeTone("np5.wav", 330, 3)]);
  await setRange(page, '[aria-label="np4 の音量"]', 0.5);
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  const prism = await exportPrism(page, "newproject.prism");

  page.once("dialog", (d) => void d.accept());
  await newButton(page).click();
  await expect(page.getByTestId("track-head")).toHaveCount(0);

  /* 0 本なので確認ダイアログは出ない。 */
  await page.setInputFiles("[data-testid=project-picker]", prism);
  await expect(page.getByTestId("track-head")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId("log")).toContainText("newproject.prism を開きました");
  await expect(page.getByTestId("track-head").first()).toContainText("np4");
  await expect(page.getByTestId("track-head").first()).toContainText("50");
  await expect(page.locator(".clock i")).toHaveText("/ 00:03.00");
});
