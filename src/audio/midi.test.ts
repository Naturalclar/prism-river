import { describe, expect, it } from "vitest";
import { waveFor } from "./midi";

/**
 * #70: waveFor の帯の境界。GM の Synth Lead（0 始まりで 80〜87）が
 * 最後の受け皿（sine）に落ちていた回帰を固定する。
 * audio/ 配下だが DOM 非依存の純粋関数なので vitest から直接叩ける。
 */
describe("waveFor", () => {
  it("UI の音色（TONES）が想定どおりの波形になる", () => {
    expect(waveFor(0)).toBe("triangle"); /* ピアノ */
    expect(waveFor(16)).toBe("sine"); /* オルガン */
    expect(waveFor(33)).toBe("sawtooth"); /* ベース */
    expect(waveFor(80)).toBe("square"); /* リード — 修正前は sine だった */
  });

  it("Synth Lead の帯（80〜87）は全部 square", () => {
    for (let p = 80; p <= 87; p++) expect(waveFor(p)).toBe("square");
  });

  it("隣の帯の境界は変わらない", () => {
    expect(waveFor(79)).toBe("square"); /* パイプの端 */
    expect(waveFor(88)).toBe("sine"); /* パッドの頭 */
    expect(waveFor(127)).toBe("sine");
  });
});
