import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages のサブパス配下でもそのまま開けるように相対パスで出す。
  base: "./",
  build: { target: "es2022" },
  test: {
    environment: "node",
    /* e2e/ の *.test.ts も見る（テスト音源の置き方そのものを試す・#90）。
       Playwright 側は testMatch を *.spec.ts に絞ってあるので二重には走らない。 */
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
