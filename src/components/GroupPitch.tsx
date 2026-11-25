import { useEffect, useRef, useState } from "react";
import { engine } from "../audio/instance";
import type { TrackView } from "../audio/types";

type Session = { controller: AbortController; plan?: Awaited<ReturnType<typeof engine.previewGroupPitch>> };
const plans = engine.mixPlans;

function release(session: Session | null) {
  if (!session) return;
  session.controller.abort();
  if (session.plan) plans.release(session.plan);
}

export function GroupPitch({ tracks }: { tracks: TrackView[] }) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [delta, setDelta] = useState("-3");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const active = useRef<Session | null>(null);

  function cancel() {
    release(active.current);
    active.current = null;
    setSession(null);
    setMessage("");
  }
  useEffect(() => {
    const off = engine.onTouched(cancel);
    return () => { off(); release(active.current); active.current = null; };
  }, []);

  const selected = tracks.filter(t => ids.includes(t.id)).map(t => t.id);

  async function preview() {
    cancel();
    const request: Session = { controller: new AbortController() };
    active.current = request;
    setSession(request);
    try {
      const ref = await engine.previewGroupPitch(selected, Number(delta), request.controller.signal);
      if (request.controller.signal.aborted) { plans.release(ref); return; }
      const ready = { ...request, plan: ref };
      active.current = ready;
      setSession(ready);
      await plans.listen(ref, "B");
    } catch (error) {
      if (request.controller.signal.aborted) return;
      cancel();
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  function report(error: unknown) {
    setMessage(error instanceof Error ? error.message : String(error));
  }
  const plan = session?.plan;
  const side = plan ? engine.sideForPlan(plan.id) : null;
  const rangeLabel = plan ? `試聴区間 ${plan.range.start.toFixed(2)}〜${plan.range.end.toFixed(2)} 秒` : "";
  return <section className="group-pitch">
    <button className="ghost" aria-expanded={open} onClick={() => { cancel(); setOpen(!open); }}>まとめて移調</button>
    {open && <>
      <fieldset><legend>移調するトラック</legend>{tracks.map(t =>
        <label key={t.id}><input type="checkbox" checked={ids.includes(t.id)} onChange={e => {
          cancel();
          setIds(e.currentTarget.checked ? [...ids, t.id] : ids.filter(id => id !== t.id));
        }} />{t.name}</label>
      )}</fieldset>
      <label>半音差 <input type="number" min={-24} max={24} step={1} value={delta}
        onChange={e => { cancel(); setDelta(e.currentTarget.value); }} /></label>
      <div className="seg-row">
        <button className="ghost" disabled={!selected.length || !!session} onClick={() => void preview()}>移調を試聴</button>
        {plan && <>
          <button className="ghost" aria-pressed={side === "A"} onClick={() => void plans.listen(plan, "A").catch(report)}>A 原曲</button>
          <button className="ghost" aria-pressed={side === "B"} onClick={() => void plans.listen(plan, "B").catch(report)}>B 移調後</button>
          <button className="ghost" onClick={() => { try { plans.apply(plan); } catch (e) { report(e); } }}>移調を採用</button>
        </>}
        {session && <button className="ghost" onClick={cancel}>キャンセル</button>}
        {plans.canUndo && <button className="ghost" onClick={() => { try { plans.undo(); } catch (e) { report(e); } }}>直前の採用を元に戻す</button>}
      </div>
      <span role="status">{message || (session && !plan ? "試聴を準備中…" : rangeLabel)}</span>
    </>}
  </section>;
}
