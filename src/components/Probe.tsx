import type { Snapshot } from "../audio/engine";

type Cell = { id: string; label: string; value: string; ok?: boolean };

/**
 * 下段のテレメトリ。この数字を出すことがこのツールの主目的なので、
 * UI を作り替えても同等の情報は残すこと。
 */
export function Probe({ snap }: { snap: Snapshot }) {
  const t = snap.telemetry;
  const cells: Cell[] = [
    { id: "sr", label: "Sample rate", value: t.sampleRate },
    { id: "lat", label: "Output latency", value: t.latency },
    { id: "trk", label: "Tracks", value: String(snap.tracks.length) },
    { id: "dec", label: "Decoded", value: t.decoded },
    { id: "ram", label: "RAM (PCM)", value: t.ram },
    { id: "off", label: "Offline render", value: t.offline, ok: t.offlineOk },
    { id: "webm", label: "webm export", value: t.webm, ok: t.webm !== "未実行" },
  ];

  return (
    <dl className="probe">
      {cells.map((c) => (
        <div className="cell" key={c.id}>
          <dt>{c.label}</dt>
          <dd className={c.ok ? "ok" : undefined} data-testid={`probe-${c.id}`}>
            {c.value}
          </dd>
        </div>
      ))}
      <div className="log" data-testid="log">
        {snap.message}
      </div>
    </dl>
  );
}
