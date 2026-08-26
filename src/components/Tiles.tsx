import { useEffect, useRef } from "react";

/** 1タイルの最大幅（CSS px）。dpr=2 でも 16384 デバイス px に収まり、
    canvas の一辺上限（Chromium 65535 / Safari 32767）に届かない。 */
export const TILE_W = 8192;

type Paint = (g: CanvasRenderingContext2D, x0: number, w: number) => void;

/**
 * 横に長い描画を canvas のタイル列に割る。1枚の canvas を全幅で持つと、
 * 長尺や高ズームで一辺上限を超えた時点で描画が黙って全部無効になる
 * （例: 10分のトラックは既定ズームでも dpr=2 で上限超え）。
 * 上限に収まる幅へ分割し、画面に入ったタイルだけ paint で描く。
 * paint に渡す g は全体座標系（タイルぶん translate 済み）。
 */
export function Tiles({
  width,
  height,
  paint,
  deps,
}: {
  width: number;
  height: number;
  paint: Paint;
  /** これが変わったら描き直す（paint 自体は毎レンダー作り直されるので見ない）。 */
  deps: readonly (string | number)[];
}) {
  const n = Math.max(1, Math.ceil(width / TILE_W));
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Tile
          key={i}
          x0={i * TILE_W}
          w={Math.min(TILE_W, width - i * TILE_W)}
          h={height}
          paint={paint}
          deps={deps}
        />
      ))}
    </>
  );
}

function Tile({
  x0,
  w,
  h,
  paint,
  deps,
}: {
  x0: number;
  w: number;
  h: number;
  paint: Paint;
  deps: readonly (string | number)[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  /* 最新の paint を保持する。effect の依存は deps 側で制御していて、
     スナップショット更新のたびに全タイルを描き直したくない。 */
  const paintRef = useRef(paint);
  useEffect(() => {
    paintRef.current = paint;
  });

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let painted = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (painted || !entries.some((e) => e.isIntersecting)) return;
        painted = true;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = w * dpr;
        cv.height = h * dpr;
        const g = cv.getContext("2d");
        if (!g) return;
        g.scale(dpr, dpr);
        g.translate(-x0, 0);
        paintRef.current(g, x0, w);
      },
      /* スクロールで入ってくる少し手前で描いておく */
      { rootMargin: "0px 256px" },
    );
    io.observe(cv);
    return () => io.disconnect();
  }, [x0, w, h, ...deps]);

  /* width/height 属性の 0 は「未描画」の印。描画時に実サイズへ張り替える。
     flex 行に並ぶので、コンテナ側の都合で縮まないよう flexShrink を切る。 */
  return <canvas ref={ref} width={0} height={0} style={{ width: w, height: h, flexShrink: 0 }} />;
}
