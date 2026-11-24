import { createServer } from "vite";
import { expect, load, makeTone, savedProject, setRange, test } from "./helpers";

// React's mount effect replay is only enabled by the development build.
test("StrictModeの起動時に保存済みトラックを一度だけ復元する", async ({ page }) => {
  const dev = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
  try {
    await dev.listen();
    await page.goto(dev.resolvedUrls!.local[0]);
    await load(page, [makeTone("strict-restore.wav", 330, 1)]);
    await setRange(page, "#mVol", 0.4);
    await expect.poll(async () => (await savedProject(page))?.masterVol).toBe(0.4);
    await page.addInitScript(() => {
      let decodes = 0;
      const decode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = function (...args) {
        document.documentElement.dataset.restoreDecodes = String(++decodes);
        if (sessionStorage.getItem("fail-next-restore")) {
          sessionStorage.removeItem("fail-next-restore");
          return Promise.reject(new Error("test decode failure"));
        }
        return decode.apply(this, args);
      };
    });
    await page.reload();
    await expect(page.getByTestId("log")).toContainText("前回の続きから開きました");
    await expect(page.locator("html")).toHaveAttribute("data-restore-decodes", "1");
    await expect(page.getByTestId("track-head")).toHaveCount(1);
    await expect(page.locator("#mVol")).toHaveValue("0.4");

    await page.evaluate(() => sessionStorage.setItem("fail-next-restore", "1"));
    await page.reload();
    await expect(page.getByTestId("log")).toContainText("復元に失敗しました");
    await page.getByRole("button", { name: "前回を復元" }).click();
    await expect(page.getByTestId("log")).toContainText("前回のプロジェクトを復元しました");
    await expect(page.getByTestId("track-head")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("data-restore-decodes", "2");
  } finally {
    await dev.close();
  }
});
