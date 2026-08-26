import { defineConfig } from "@playwright/test";

/**
 * ブラウザは Playwright が入れたものを使う（`pnpm exec playwright install chromium`）。
 * 既に別の Chromium がある環境では `CHROMIUM_PATH` でそれを指せる。
 */
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      /* ヘッドレスでも AudioContext が即座に走るようにする。 */
      args: ["--autoplay-policy=no-user-gesture-required"],
      ...(executablePath ? { executablePath } : {}),
    },
  },
  webServer: {
    /* --host を明示する。preview の既定は localhost で、GitHub Actions のランナーだと
       それが ::1 に寄って 127.0.0.1 へ繋がらない。 */
    command: "pnpm build && pnpm preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
