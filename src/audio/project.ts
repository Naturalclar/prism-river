import type { LoopRange } from "../lib/loop";
import { PROJECT_VERSION, type BusVols, type ProjectMeta } from "../lib/store";
import type { Track } from "./types";

/**
 * シリアライズ可能な現在状態を組む（保存 #18 の出力側）。ストレージの都合は
 * lib/store 側、復元（デコードとノードの組み直し）は Engine 側に置く。
 */
export function projectMetaOf(
  tracks: Track[],
  masterVol: number,
  pxPerSec: number,
  busVol: BusVols,
  loop: LoopRange | null,
): ProjectMeta {
  return {
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    masterVol,
    pxPerSec,
    busVol: { ...busVol },
    loop: loop ? { ...loop } : null,
    tracks: tracks.map((t) => ({
      name: t.name,
      srcName: t.srcName,
      vol: t.vol,
      panv: t.panv,
      mute: t.mute,
      solo: t.solo,
      offset: t.offset,
      trimStart: t.trimStart,
      trimEnd: t.trimEnd,
      fadeIn: t.fadeIn,
      fadeOut: t.fadeOut,
      fx: { eq: { ...t.fx.eq }, comp: { ...t.fx.comp } },
      color: t.color,
      bus: t.bus,
      ...(t.midiChannel === null ? {} : { midiChannel: t.midiChannel }),
      ...(t.stretch === null ? {} : { stretch: { ...t.stretch } }),
    })),
  };
}
