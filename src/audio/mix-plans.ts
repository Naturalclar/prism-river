import { encodeWav } from "../lib/wav";
import type { LoopRange } from "../lib/loop";
import { MAX_COMPARE_SECONDS, type CompareSide, type PreparedPair } from "./comparison";
import type { Track } from "./types";

export type MixChange = { trackId: string; gainDbDelta?: number; room?: number };
export type PreviewRequest = { revision: number; changes: MixChange[]; range?: LoopRange };
export type PlanRef = { revision: number; id: string };
type MixValue = { track: Track; vol: number; room: number };
type Plan = { pair: PreparedPair; apply(): void; undo(): void };
type Host = {
  tracks(): Track[];
  selection(): LoopRange | null;
  render(candidate: Track[], range: LoopRange): Promise<PreparedPair>;
  listen(id: string, pair: PreparedPair, side: CompareSide): Promise<void>;
  stop(id: string): void;
  write(values: MixValue[]): void;
};

export function mixError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** プレビュー用のバッファと適用操作はメモリだけに保持する。 */
export class MixPlans {
  private revision = 0;
  private plans = new Map<string, Plan>();
  private undoLast: (() => void) | null = null;

  constructor(private host: Host) {}

  changed(): void {
    this.revision++;
    this.plans.clear();
    this.undoLast = null;
  }

  inspect() {
    const range = this.host.selection();
    return {
      schemaVersion: 1, revision: this.revision, timeUnit: "seconds" as const,
      range: range ? { ...range } : null,
      tracks: this.host.tracks().map(t => ({ id: t.id, name: t.name, gain: t.vol, room: t.fx.room })),
    };
  }

  check(revision: number): void {
    if (revision !== this.revision) mixError("stale_revision", "編集内容が変わりました。もう一度試聴してください。");
  }

  async preview(input: PreviewRequest) {
    if (!input || !Number.isSafeInteger(input.revision)) mixError("invalid_request", "revision が必要です。");
    this.check(input.revision);
    const selection = this.host.selection();
    if (!selection) mixError("missing_range", "ルーラーで試聴範囲を選択してください。");
    const range = input.range === undefined ? {
      start: selection.start, end: Math.min(selection.end, selection.start + MAX_COMPARE_SECONDS),
    } : input.range;
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) ||
      range.start < selection.start || range.end > selection.end || range.end - range.start < 0.01 ||
      range.end - range.start > MAX_COMPARE_SECONDS) mixError("invalid_range", "選択内の0.01〜12秒を指定してください。");
    if (!Array.isArray(input.changes) || !input.changes.length) mixError("invalid_changes", "変更が必要です。");

    const tracks = this.host.tracks();
    const updated = new Map<string, MixValue>();
    for (const change of input.changes) {
      if (!change || typeof change !== "object" || Object.keys(change).some(k => !["trackId", "gainDbDelta", "room"].includes(k)) ||
        (change.gainDbDelta === undefined && change.room === undefined)) mixError("invalid_changes", "ゲインとリバーブのみ指定できます。");
      const track = tracks.find(t => t.id === change.trackId);
      if (!track) mixError("unknown_track", "トラックが見つかりません。");
      if (updated.has(track.id)) mixError("invalid_changes", "同じトラックの変更はまとめてください。");
      const delta = change.gainDbDelta === undefined ? 0 : change.gainDbDelta;
      const room = change.room === undefined ? track.fx.room : change.room;
      const vol = track.vol * 10 ** (delta / 20);
      if (!Number.isFinite(delta) || !Number.isFinite(vol) || vol > 1.4 ||
        !Number.isFinite(room) || room < 0 || room > 1) mixError("invalid_value", "ゲインまたはリバーブが範囲外です。");
      updated.set(track.id, { track, vol, room });
    }
    const after = [...updated.values()];
    const before = after.map(({ track }) => ({ track, vol: track.vol, room: track.fx.room }));
    // プレビューはライブのトラックを変更しない。
    // oxlint-disable-next-line no-map-spread
    const candidate = tracks.map(track => {
      const value = updated.get(track.id);
      return value ? { ...track, vol: value.vol, fx: { ...track.fx, room: value.room } } : track;
    });
    return this.prepare(input.revision, { ...range }, candidate, () => this.host.write(after), () => this.host.write(before));
  }

  async prepare(revision: number, range: LoopRange, candidate: Track[], apply: () => void, undo: () => void) {
    this.check(revision);
    const pair = await this.host.render(candidate, range);
    this.check(revision);
    const id = crypto.getRandomValues(new Uint32Array(4)).join("-");
    this.plans.set(id, { pair, apply, undo });
    return { id, revision, range: { ...range } };
  }

  private get(ref: PlanRef): Plan {
    if (!ref || typeof ref.id !== "string") mixError("unknown_preview", "試聴案が見つかりません。");
    this.check(ref.revision);
    const plan = this.plans.get(ref.id);
    if (!plan) mixError("unknown_preview", "試聴案が見つかりません。");
    return plan;
  }

  async listen(ref: PlanRef, side: CompareSide) {
    const { pair } = this.get(ref);
    if (side !== "A" && side !== "B") mixError("invalid_side", "A または B を指定してください。");
    await this.host.listen(ref.id, pair, side);
    this.check(ref.revision);
  }

  wav(ref: PlanRef, side: CompareSide): Blob {
    const { pair } = this.get(ref);
    if (side !== "A" && side !== "B") mixError("invalid_side", "A または B を指定してください。");
    return encodeWav(pair.buffers[side === "A" ? 0 : 1]);
  }

  discard(ref: PlanRef): void {
    this.get(ref);
    this.release(ref);
  }

  release(ref: PlanRef): void {
    this.host.stop(ref.id);
    this.plans.delete(ref.id);
  }

  apply(ref: PlanRef): void {
    const plan = this.get(ref);
    plan.apply();
    this.undoLast = plan.undo;
  }

  get canUndo(): boolean { return this.undoLast !== null; }

  undo(): void {
    const undo = this.undoLast;
    if (!undo) mixError("nothing_to_undo", "戻せる提案がありません。");
    undo();
  }
}
