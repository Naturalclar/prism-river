import { useEffect, useRef, useState } from "react";
import { engine } from "../audio/instance";
import { MAX_PITCH_SECONDS, noteName, pitchMidi, type PitchFrame } from "../lib/pitch";

export function PitchPanel({ id, available }: { id: string; available: boolean }) {
  const worker = useRef<Worker | null>(null);
  const [frames, setFrames] = useState<PitchFrame[]>([]);
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState("");
  useEffect(() => {
    const clear = () => {
      worker.current?.terminate();
      worker.current = null;
      setFrames([]);
      setStatus("");
    };
    const unsubscribe = engine.onTouched(clear);
    return () => { unsubscribe(); worker.current?.terminate(); };
  }, []);
  function analyze() {
    const phrase = engine.copyPitchPhrase(id);
    if (!phrase) { setStatus("選択範囲とトラックが重なる箇所を指定してください。"); return; }
    worker.current?.terminate();
    const next = new Worker(new URL("../audio/pitchworker.ts", import.meta.url), { type: "module" });
    worker.current = next;
    setFrames([]);
    setStatus("音程を解析中 …");
    next.addEventListener("error", () => {
      if (worker.current !== next) return;
      next.terminate();
      worker.current = null;
      setStatus("音程を解析できませんでした。");
    });
    next.addEventListener("message", (event: MessageEvent<PitchFrame[]>) => {
      if (worker.current !== next) return;
      next.terminate();
      worker.current = null;
      setOrigin(phrase.start);
      setFrames(event.data);
      setCursor(Math.max(0, event.data.findIndex((frame) => frame.hz !== null)));
      setStatus(event.data.some((frame) => frame.hz !== null) ? "" : "確かな音程を検出できませんでした。");
    });
    next.postMessage({ pcm: phrase.pcm, sampleRate: phrase.sampleRate }, [phrase.pcm.buffer]);
  }
  const notes = frames.flatMap(({ hz }) => hz === null ? [] : [pitchMidi(hz)]);
  const min = Math.floor(Math.min(...notes, target === "" ? Infinity : Number(target))) - 1;
  const max = Math.ceil(Math.max(...notes, target === "" ? -Infinity : Number(target))) + 1;
  const y = (note: number) => 58 - 56 * (note - min) / (max - min);
  const x = (index: number) => 2 + 236 * index / Math.max(1, frames.length - 1);
  const frame = frames[cursor];
  return (
    <div className="pitch-panel">
      <button disabled={!available} onClick={analyze}
        title="単独ボーカルと重なる範囲をルーラーで選択">
        選択トラックの音程を表示（最大{MAX_PITCH_SECONDS}秒）
      </button>
      {status && <small role="status">{status}</small>}
      {notes.length > 0 && frame && (
        <>
          <label>目標音 <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">未指定</option>
            {Array.from({ length: 49 }, (_, i) => i + 36).map((n) => <option key={n} value={n}>{noteName(n)}</option>)}
          </select></label>
          <svg role="img" aria-label="選択トラックの音程の推移" viewBox="0 0 240 60">
            {target !== "" && <line x1="0" x2="240" y1={y(Number(target))} y2={y(Number(target))} stroke="currentColor" strokeDasharray="4 3" />}
            {frames.map(({ hz }, i) => hz === null ? null :
              <circle key={i} cx={x(i)} cy={y(pitchMidi(hz))} r={1.6} fill="currentColor" />)}
            <line x1={x(cursor)} x2={x(cursor)} y1="0" y2="60" stroke="currentColor" opacity="0.45" />
          </svg>
          <input aria-label="音程の読み取り位置" type="range" min={0} max={frames.length - 1} value={cursor}
            onChange={(e) => setCursor(e.currentTarget.valueAsNumber)} />
          <output>{(origin + frame.time).toFixed(2)} 秒 · {frame.hz === null ? "判定なし" :
            `${frame.hz.toFixed(1)} Hz · ${noteName(pitchMidi(frame.hz))}${target === "" ? "" : ` · 目標との差 ${Math.round((pitchMidi(frame.hz) - Number(target)) * 100)} cent`}`}</output>
        </>
      )}
    </div>
  );
}
