import { expect, test } from "./helpers";

/**
 * #69: OGP と canonical。
 *
 * 相対 URL に戻る・タグが消えるといった退行は **見た目には何も壊れない**ので
 * 気づけない（SNS に貼って初めて分かる）。ビルド後の HTML で押さえておく。
 */

const CANONICAL = "https://smashcat.dev/prism-river/";

/** `<meta property|name="...">` の content を取る。 */
async function meta(page: import("@playwright/test").Page, key: string): Promise<string | null> {
  return page
    .locator(`meta[property="${key}"], meta[name="${key}"]`)
    .first()
    .getAttribute("content");
}

test("OGP と canonical が入っていて、URL は絶対で smashcat.dev を指す", async ({ page }) => {
  /* 公開先を正規と明示する（同じ内容が GitHub Pages の URL からも見えるため）。 */
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", CANONICAL);

  expect(await meta(page, "og:type")).toBe("website");
  expect(await meta(page, "og:url")).toBe(CANONICAL);
  expect(await meta(page, "og:title")).toBe("Prism River");
  expect(await meta(page, "og:description")).toBe("ブラウザだけで完結するマルチトラック音声エディタ。");
  expect(await meta(page, "og:site_name")).toBe("Prism River");
  expect(await meta(page, "og:locale")).toBe("ja_JP");

  /* これが無いと X で大きい画像カードにならない。 */
  expect(await meta(page, "twitter:card")).toBe("summary_large_image");

  /* SNS のクローラは相対パスを辿らないので、絶対 URL でなければ意味がない。 */
  const image = await meta(page, "og:image");
  expect(image).toBe(`${CANONICAL}ogp.png`);
  expect(image?.startsWith("https://")).toBe(true);
  expect(await meta(page, "og:image:width")).toBe("1200");
  expect(await meta(page, "og:image:height")).toBe("630");
  expect(await meta(page, "og:image:alt")).toBeTruthy();
});

test("og:image が指す画像が実際に配信される", async ({ page }) => {
  /* 宣言したサイズと中身が食い違わないこと。ファイル名を変えて片方だけ直す、
     という取り違えをここで捕まえる。 */
  const res = await page.request.get("./ogp.png");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");

  const bytes = Buffer.from(await res.body());
  /* PNG の IHDR は先頭固定位置に幅・高さを持つ。 */
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1200);
  expect(bytes.readUInt32BE(20)).toBe(630);
});
