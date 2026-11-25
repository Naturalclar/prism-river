import { engine } from "./audio/instance";
import type { PreviewRequest, PlanRef } from "./audio/mix-plans";
import type { CompareSide } from "./audio/comparison";

const plans = engine.mixPlans;
const api = Object.freeze({
  inspect: () => plans.inspect(),
  preview: (request: PreviewRequest) => plans.preview(request),
  listen: (ref: PlanRef, side: CompareSide) => plans.listen(ref, side),
  stop: () => engine.stopComparison(),
  wav: (ref: PlanRef, side: CompareSide) => plans.wav(ref, side),
  apply: (ref: PlanRef) => plans.apply(ref),
  discard: (ref: PlanRef) => plans.discard(ref),
  undo: () => plans.undo(),
});

declare global {
  interface Window { prismRiver: typeof api }
}
window.prismRiver = api;
