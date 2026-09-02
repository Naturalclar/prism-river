import { describe, expect, it } from "vitest";
import { snapEdge, snapOffset } from "./snap";

/* しきい値 0.1s（既定ズーム 70px/s で約 7px 相当）で見る。 */
const TH = 0.1;

describe("snapOffset", () => {
  it("しきい値内なら左端がスナップ点に吸着する", () => {
    expect(snapOffset(1.94, 1, [2], TH)).toEqual({ offset: 2, snapped: 2 });
    expect(snapOffset(2.06, 1, [2], TH)).toEqual({ offset: 2, snapped: 2 });
  });

  it("しきい値の外なら素通し", () => {
    expect(snapOffset(1.8, 1, [2], TH)).toEqual({ offset: 1.8, snapped: null });
  });

  it("右端合わせも候補になる（自分の終端を相手の端に揃える）", () => {
    /* 右端 = 3.05 が 3 に吸着 → offset は 2。 */
    expect(snapOffset(2.05, 1, [3], TH)).toEqual({ offset: 2, snapped: 3 });
  });

  it("右端合わせで offset が負になる組み合わせは捨てる", () => {
    /* duration 2 の右端を 0.5 に合わせると offset -1.5。左端も遠いので素通し。 */
    expect(snapOffset(0.3, 2, [0.5], 0.4)).toEqual({ offset: 0.5, snapped: 0.5 });
    expect(snapOffset(0.3, 2, [0.5], 0.15)).toEqual({ offset: 0.3, snapped: null });
  });

  it("候補が複数あればずれが最小のものを採る", () => {
    /* 左端→2 のずれ 0.06、左端→2.1 のずれ 0.04。 */
    expect(snapOffset(2.06, 1, [2, 2.1], TH)).toEqual({ offset: 2.1, snapped: 2.1 });
    /* 左端→5 のずれ 0.08 より、右端→6 のずれ 0.02 が近い。 */
    expect(snapOffset(5.08, 0.9, [5, 6], TH)).toEqual({
      offset: 6 - 0.9,
      snapped: 6,
    });
  });

  it("0 秒にも吸着する（曲頭にぴったり戻せる）", () => {
    expect(snapOffset(0.07, 1, [0], TH)).toEqual({ offset: 0, snapped: 0 });
  });

  it("スナップ点が無ければ素通し", () => {
    expect(snapOffset(1.23, 1, [], TH)).toEqual({ offset: 1.23, snapped: null });
  });
});

describe("snapEdge", () => {
  it("しきい値内なら最も近いスナップ点に吸着する", () => {
    expect(snapEdge(1.95, [2], TH)).toEqual({ at: 2, snapped: 2 });
    expect(snapEdge(2.05, [2], TH)).toEqual({ at: 2, snapped: 2 });
  });

  it("しきい値の外なら素通し", () => {
    expect(snapEdge(1.8, [2], TH)).toEqual({ at: 1.8, snapped: null });
  });

  it("候補が複数あればずれが最小のものを採る", () => {
    expect(snapEdge(2.06, [2, 2.1], TH)).toEqual({ at: 2.1, snapped: 2.1 });
  });

  it("候補が無ければ素通し", () => {
    expect(snapEdge(1.5, [], TH)).toEqual({ at: 1.5, snapped: null });
  });

  it("0 秒もスナップ点として扱える（値が 0 でも吸着する）", () => {
    expect(snapEdge(0.04, [0, 3], TH)).toEqual({ at: 0, snapped: 0 });
  });
});
