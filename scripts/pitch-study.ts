import { encodeWav } from "../src/lib/wav";
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const number = (id: string) => el<HTMLInputElement>(id).valueAsNumber;
const raw = el<HTMLAudioElement>("raw"), wet = el<HTMLAudioElement>("wet");
raw.addEventListener("play", () => wet.pause());
wet.addEventListener("play", () => raw.pause());
const run = el<HTMLButtonElement>("run");
const power = (v: Float32Array) => v.reduce((s, x) => s + x * x, 0);
run.addEventListener("click", async () => {
  const status = el("result");
  const file = el<HTMLInputElement>("file").files?.[0];
  status.textContent = "";
  for (const audio of [raw, wet]) {
    audio.pause();
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.removeAttribute("src");
    audio.load();
  }
  if (!file) { status.textContent = "WAVを選んでください。"; return; }
  const ctx = new AudioContext();
  const worker = new Worker(new URL("./pitch-study-worker.ts", import.meta.url), { type: "module" });
  try {
    run.disabled = true;
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const rate = buf.sampleRate;
    const dry = buf.getChannelData(0);
    const first = Math.round(number("start") * rate), last = Math.round(number("end") * rate);
    const midi = number("target");
    if (!Number.isFinite(first + last + midi) || first < 0 || last > dry.length ||
      last <= first || last - first > rate * 8) throw new Error("フレーズ範囲を確認してください（最大8秒）");
    const pcm = dry.slice(first, last);
    const response = new Promise<MessageEvent>((resolve, reject) => {
      worker.addEventListener("message", resolve, { once: true });
      worker.addEventListener("error", (e) => reject(new Error(e.message)), { once: true });
    });
    worker.postMessage({ pcm, rate, midi }, [pcm.buffer]);
    const { data } = await response;
    if (data.error) throw new Error(data.error);
    const a = Math.max(0, first - Math.round(0.45 * rate));
    const b = Math.min(dry.length, last + Math.round(0.45 * rate));
    const before = dry.slice(a, b), after = before.slice();
    after.set(data.shifted, first - a);
    // Match RMS over exactly the same audition window, attenuating the louder version only.
    const levels = [before, after].map((v) => Math.sqrt(power(v) / v.length));
    const target = Math.min(...levels);
    [before, after].forEach((v, i) => {
      const gain = levels[i] > 0 && target > 0 ? target / levels[i] : 1;
      for (let j = 0; j < v.length; j++) v[j] *= gain;
      const audio = [raw, wet][i];
      audio.src = URL.createObjectURL(encodeWav({ numberOfChannels: 1, length: v.length,
        sampleRate: rate, getChannelData: () => v }));
    });
    status.textContent = JSON.stringify({ ...data.info, auditionGains: levels.map((v) => target / v) }, null, 2);
  } catch (e) { status.textContent = String(e); }
  finally { worker.terminate(); await ctx.close(); run.disabled = false; }
});
