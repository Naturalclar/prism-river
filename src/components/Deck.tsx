import { useRef } from "react";
import { engine } from "../audio/instance";
import type { Snapshot } from "../audio/engine";
import { Clock } from "./Clock";
import { Meters } from "./Meters";

const PLAY = "M3 2l11 6-11 6z";
const PAUSE = "M3 2h4v12H3zM9 2h4v12H9z";

export function Deck({ snap }: { snap: Snapshot }) {
  const picker = useRef<HTMLInputElement>(null);
  const idle = snap.tracks.length === 0;

  return (
    <div className="deck">
      <div className="brand">
        <h1>Prism River</h1>
        <small>Multitrack in the browser</small>
      </div>

      <div className="keys">
        <button
          className={`key${snap.playing ? " lit" : ""}`}
          disabled={idle}
          title="再生 / 一時停止 (Space)"
          aria-label={snap.playing ? "一時停止" : "再生"}
          onClick={() => engine.toggle()}
        >
          <svg viewBox="0 0 16 16">
            <path d={snap.playing ? PAUSE : PLAY} />
          </svg>
        </button>
        <button
          className="key"
          disabled={idle}
          title="停止 (先頭へ戻る)"
          aria-label="停止"
          onClick={() => engine.stop()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M3 3h10v10H3z" />
          </svg>
        </button>
        <button
          className={`key${snap.looping ? " lit" : ""}`}
          disabled={idle}
          title="ループ"
          aria-label="ループ"
          aria-pressed={snap.looping}
          onClick={() => engine.toggleLoop()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M4 4h7v2l3-3-3-3v2H2v5h2V4zm8 8H5v-2l-3 3 3 3v-2h9V9h-2v3z" />
          </svg>
        </button>
        <button
          className={`key${snap.recording ? " rec" : ""}`}
          title={snap.recording ? "録音を停止してトラックにする" : "マイクから録音"}
          aria-label={snap.recording ? "録音を停止" : "マイクから録音"}
          aria-pressed={snap.recording}
          onClick={() => engine.toggleRecord()}
        >
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="4.5" />
          </svg>
        </button>
      </div>

      <Clock />

      <div className="pot">
        <label htmlFor="mVol">Master</label>
        <input
          type="range"
          id="mVol"
          min={0}
          max={1.4}
          step={0.01}
          value={snap.masterVol}
          style={{ width: 88 }}
          onChange={(e) => engine.setMaster(e.currentTarget.valueAsNumber)}
        />
        <Meters />
      </div>

      <div className="pot">
        <label htmlFor="zoom">Zoom</label>
        <input
          type="range"
          id="zoom"
          min={8}
          max={400}
          step={1}
          value={snap.pxPerSec}
          style={{ width: 76 }}
          onChange={(e) => engine.setPxPerSec(e.currentTarget.valueAsNumber)}
        />
      </div>

      <div className="spacer" />

      <div className="acts">
        <button className="ghost" onClick={() => picker.current?.click()}>
          音声を追加
        </button>
        <button
          className="ghost"
          disabled={idle || snap.bouncing}
          onClick={() => void engine.bounce()}
        >
          ミックスを書き出す
        </button>
        {snap.hasRender && (
          <button className="ghost" onClick={() => engine.audition()}>
            {snap.auditioning ? "試聴を止める" : "レンダーを試聴"}
          </button>
        )}
      </div>

      <input
        type="file"
        ref={picker}
        accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
        multiple
        hidden
        data-testid="picker"
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files) void engine.ingest(files);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
